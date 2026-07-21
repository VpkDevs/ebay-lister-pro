/**
 * @file app.js
 * @description Main Express application configuring middleware, security headers, routing, and error handling.
 */

'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const utils = require('./utils');
const activeSessions = require('./lib/sessions');

const app = express();

// --- CORS & Security Origin Validation ---
function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol === 'chrome-extension:') return true;
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const hostname = url.hostname.toLowerCase();
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    }
    return false;
  } catch (e) {
    return false;
  }
}

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      utils.logAudit("WARN", `Blocked CORS request from disallowed origin: ${origin}`);
      callback(new Error('Cross-Origin request blocked for security.'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
};

// --- Host Header Validation ---
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const isCloudEnv = !!(process.env.RAILWAY_STATIC_URL || process.env.NODE_ENV === 'production' || process.env.ALLOW_EXTERNAL_HOSTS === 'true');
  if (!isCloudEnv && host) {
    const hostClean = host.split(':')[0].toLowerCase();
    if (hostClean !== 'localhost' && hostClean !== '127.0.0.1') {
      utils.logAudit("WARN", `Blocked request with invalid Host header: ${host}`);
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid Host header." });
    }
  }
  next();
});

// --- Rate Limiting implementation matching webServer.js ---
const rateLimits = new Map();
const RATE_LIMIT_CAPACITY = 60;
const RATE_LIMIT_REFILL_RATE = 1; // 1 token per second

const analyzeRateLimits = new Map();
const ANALYZE_LIMIT_CAPACITY = 5;
const ANALYZE_REFILL_RATE = 5 / 60; // 5 tokens per 60 seconds

function checkRateLimit(ip, path) {
  const isAnalyze = path === '/api/analyze';
  const limitsMap = isAnalyze ? analyzeRateLimits : rateLimits;
  const capacity = isAnalyze ? ANALYZE_LIMIT_CAPACITY : RATE_LIMIT_CAPACITY;
  const refillRate = isAnalyze ? ANALYZE_REFILL_RATE : RATE_LIMIT_REFILL_RATE;

  const now = Date.now();
  if (!limitsMap.has(ip)) {
    limitsMap.set(ip, { tokens: capacity - 1, lastRefill: now });
    return true;
  }

  const client = limitsMap.get(ip);
  const elapsedSeconds = (now - client.lastRefill) / 1000;
  client.tokens = Math.min(capacity, client.tokens + elapsedSeconds * refillRate);
  client.lastRefill = now;

  if (client.tokens >= 1) {
    client.tokens -= 1;
    return true;
  }
  return false;
}

function resetRateLimits() {
  rateLimits.clear();
  analyzeRateLimits.clear();
}
// --- Origin Enforcement Middleware (before rate limiting) ---
// Explicitly block disallowed origins with 403, matching original webServer.js behavior.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    utils.logAudit("WARN", `Blocked CORS request from disallowed origin: ${origin}`);
    return res.status(403).json({ error: "FORBIDDEN", message: "Cross-Origin request blocked for security." });
  }
  next();
});

app.resetRateLimits = resetRateLimits;

// Apply local API rate limiting
app.use('/api', (req, res, next) => {
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
  if (!checkRateLimit(clientIp, req.path)) {
    utils.logAudit("WARN", `Rate limit exceeded by ${clientIp} on ${req.path}`);
    return res.status(429).json({ error: "TOO_MANY_REQUESTS", message: "Rate limit exceeded. Please slow down." });
  }
  next();
});

// --- Security Headers (Helmet) ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  xssFilter: false
}));

app.use((req, res, next) => {
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.use(cors(corsOptions));
app.use(compression());

// --- Body Parsers with route-specific limits ---
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.post('/api/analyze', express.json({ limit: '50mb' }));
app.post('/api/images/spruce', express.json({ limit: '20mb' }));
app.post('/api/save-draft', express.json({ limit: '20mb' }));
app.post('/api/publish', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- Cookie Parser Middleware (Inline/Simplified) ---
app.use((req, res, next) => {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  req.cookies = list;
  next();
});

// --- Metrics Tracking Middleware ---
app.use((req, res, next) => {
  const startTime = Date.now();
  const pathKey = `${req.method} ${req.path}`;
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';

  // Increment total request counter in global metrics
  if (global.serverMetrics) {
    global.serverMetrics.totalRequests++;
    global.serverMetrics.endpointCounts[pathKey] = (global.serverMetrics.endpointCounts[pathKey] || 0) + 1;
  }

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (global.serverMetrics) {
      if (!global.serverMetrics.latencyData.has(pathKey)) {
        global.serverMetrics.latencyData.set(pathKey, []);
      }
      const latencies = global.serverMetrics.latencyData.get(pathKey);
      latencies.push(duration);
      if (latencies.length > 500) latencies.shift();

      if (res.statusCode >= 400) {
        global.serverMetrics.endpointErrors[pathKey] = (global.serverMetrics.endpointErrors[pathKey] || 0) + 1;
      }
    }
  });

  next();
});

// --- Session and Authentication Middleware ---
app.use((req, res, next) => {
  // Check Chrome Extension API Key header or query param
  const apiKey = req.headers['x-lister-api-key'] || req.query.apiKey;
  if (apiKey === config.getAPI_KEY()) {
    req.user = { email: "extension@local.lister", role: "API_USER", isPremium: true };
    return next();
  }

  const sessionId = req.cookies.sessionId;
  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    if (Date.now() < session.expiresAt) {
      req.user = session.user;
    } else {
      activeSessions.delete(sessionId);
    }
  }

  next();
});

// --- Authentication Guard ---
const OPEN_PATHS = new Set([
  '/', '/index.html',
  '/landing', '/landing.html',
  '/privacy', '/privacy.html',
  '/terms', '/terms.html',
  '/press', '/press.html',
  '/health',
  '/api/status',
  '/api/metrics',
  '/api/auth/google/login',
  '/api/auth/google/callback',
  '/api/billing/webhook',
  '/api/billing/mock-success'
]);

app.use((req, res, next) => {
  const isApiRoute = req.path.startsWith('/api/');
  const isAssetRoute = /\.(js|css|png|jpg|jpeg|webp|ico|svg)$/i.test(req.path);
  const isAuthRequired = config.getGOOGLE_CLIENT_ID() && !OPEN_PATHS.has(req.path) && !isAssetRoute;

  if (isAuthRequired && !req.user) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Please log in using Google Sign-In." });
  }
  next();
});

// --- Serve Static Assets ---
app.use('/uploads', express.static(config.uploadTempDir));
app.use(express.static(path.join(__dirname, 'public')));

// --- Mount Routers ---
app.use(require('./routes/auth'));
app.use(require('./routes/listings'));
app.use(require('./routes/ebay'));
app.use(require('./routes/photos'));
app.use(require('./routes/images'));
app.use(require('./routes/crosspost'));
app.use(require('./routes/billing'));
app.use(require('./routes/admin'));
// --- Named Page Routes (served before the SPA catch-all) ---
const PAGE_FILES = {
  '/landing': 'landing.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/press': 'press.html'
};

for (const [route, file] of Object.entries(PAGE_FILES)) {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', file));
  });
}

// --- Page routing fallback for index.html (SPA structure) ---
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Global Error Handling Middleware ---
app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  const errorCode = err.code || "INTERNAL_SERVER_ERROR";

  utils.logAudit("ERROR", `Request error at ${req.method} ${req.path}: ${err.message}`, {
    stack: err.stack,
    details: err.details
  });

  if (res.headersSent) {
    return next(err);
  }

  res.status(status).json({
    error: errorCode,
    message: utils.sanitizeLog(err.message || 'Something went wrong')
  });
});

module.exports = app;
