/**
 * @file webServer.js
 * @description Serves the HTML dashboard and exposes JSON endpoints for listing synchronization, analysis, and posting.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const config = require('./config');
const utils = require('./utils');
const ebayClient = require('./ebayClient');
const geminiClient = require('./geminiClient');

let shutdownRegistered = false;
let shopifyLocationId = null;

async function runInventoryCrossSync() {
  const shopName = config.getSHOPIFY_SHOP_NAME();
  const accessToken = config.getSHOPIFY_ACCESS_TOKEN();
  const ebayToken = ebayClient.getAccessToken();

  if (!ebayToken) {
    return;
  }

  const history = utils.readJsonFileSecure(config.historyPath, []);
  let historyChanged = false;

  for (const item of history) {
    if (item.status !== "ACTIVE") continue;

    // 1. Shopify to eBay Sync
    if (item.shopifyId && shopName && accessToken) {
      try {
        const url = `https://${shopName}.myshopify.com/admin/api/2024-01/products/${item.shopifyId}.json`;
        const response = await ebayClient.fetchWithRetry(url, {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Accept": "application/json"
          }
        });

        if (response.status === 404) {
          utils.logAudit("INFO", `Shopify product ${item.shopifyId} not found (deleted). Ending eBay SKU ${item.sku}...`);
          try {
            await ebayClient.endListingOnEbay(item.sku, item.offerId);
            item.status = "ENDED";
            historyChanged = true;
          } catch (e) {
            utils.logAudit("ERROR", `Failed to end eBay listing for SKU ${item.sku}: ${e.message}`);
          }
        } else if (response.ok) {
          const shopifyProd = await response.json();
          const product = shopifyProd.product;
          
          if (product) {
            const isInactive = product.status !== "active";
            const totalInventory = (product.variants || []).reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
            
            if (isInactive || totalInventory === 0) {
              utils.logAudit("INFO", `Shopify product ${item.shopifyId} is inactive or out of stock. Ending eBay SKU ${item.sku}...`);
              try {
                await ebayClient.endListingOnEbay(item.sku, item.offerId);
                item.status = "ENDED";
                historyChanged = true;
              } catch (e) {
                utils.logAudit("ERROR", `Failed to end eBay listing for SKU ${item.sku}: ${e.message}`);
              }
            }
          }
        }
      } catch (err) {
        utils.logAudit("WARN", `Error querying Shopify status for SKU ${item.sku}: ${err.message}`);
      }
    }

    // 2. eBay to Shopify Sync
    if (item.listingId) {
      try {
        const offerRes = await ebayClient.ebayRequest(`/offer?sku=${encodeURIComponent(item.sku)}`, "GET");
        const offers = offerRes.offers || [];
        const activeOffer = offers.find(o => o.sku === item.sku && o.status === "LISTED");

        if (!activeOffer) {
          utils.logAudit("INFO", `eBay SKU ${item.sku} is no longer active/listed on eBay. Reflecting to Shopify product ${item.shopifyId}...`);
          item.status = "ENDED";
          historyChanged = true;

          if (item.shopifyId && shopName && accessToken) {
            try {
              const url = `https://${shopName}.myshopify.com/admin/api/2024-01/products/${item.shopifyId}.json`;
              await ebayClient.fetchWithRetry(url, {
                method: "PUT",
                headers: {
                  "X-Shopify-Access-Token": accessToken,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  product: {
                    id: item.shopifyId,
                    status: "archived"
                  }
                })
              });
              utils.logAudit("INFO", `Shopify product ${item.shopifyId} set to archived.`);
            } catch (err) {
              utils.logAudit("WARN", `Failed to archive Shopify product ${item.shopifyId}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        utils.logAudit("WARN", `Error querying eBay status for SKU ${item.sku}: ${err.message}`);
      }
    }
  }

  if (historyChanged) {
    utils.writeJsonFileSecure(config.historyPath, history);
  }
}

const crypto = require('crypto');
const activeSessions = new Map();

// Metrics tracking structure
const metrics = {
  totalRequests: 0,
  endpointCounts: {},
  endpointErrors: {},
  latencyData: new Map(),
  outboundCalls: {
    total: 0,
    failures: 0
  }
};

// Zero-dependency token bucket rate limiter
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

function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:';
  } catch (e) {
    return false;
  }
}

/**
 * Helper to parse HTTP cookies.
 * @param {string} cookieHeader 
 * @returns {object}
 */
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

/**
 * Gets authenticated user session or validates API Key header.
 * @param {http.IncomingMessage} req 
 * @returns {object|null}
 */
function getAuthenticatedUser(req) {
  // Check Chrome Extension API Key header
  const apiKey = req.headers['x-lister-api-key'] || (new URL(req.url, 'http://localhost')).searchParams.get('apiKey');
  if (apiKey === config.getAPI_KEY()) {
    return { email: "extension@local.lister", role: "API_USER", isPremium: true };
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.sessionId;
  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    if (Date.now() < session.expiresAt) {
      return session.user;
    } else {
      activeSessions.delete(sessionId);
    }
  }
  return null;
}

/**
 * Starts the local loopback web server for the eBay Personal Lister dashboard.
 * @param {number} [port=45900] - Server listen port.
 * @returns {http.Server} The running http.Server instance.
 */
function startWebGuiServer(port = 45900) {
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    const traceId = crypto.randomBytes(8).toString('hex');
    utils.asyncLocalStorage.run({ traceId }, async () => {
      const startTime = Date.now();
      const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
      const parsedUrl = new URL(req.url, `http://localhost:${port}`);

      // Hook res.end to record metrics
      const originalEnd = res.end;
      res.end = function (...args) {
        const duration = Date.now() - startTime;
        const pathKey = `${req.method} ${parsedUrl.pathname}`;
        
        if (!metrics.latencyData.has(pathKey)) {
          metrics.latencyData.set(pathKey, []);
        }
        const latencies = metrics.latencyData.get(pathKey);
        latencies.push(duration);
        if (latencies.length > 500) {
          latencies.shift();
        }

        metrics.totalRequests++;
        metrics.endpointCounts[pathKey] = (metrics.endpointCounts[pathKey] || 0) + 1;
        if (res.statusCode >= 400) {
          metrics.endpointErrors[pathKey] = (metrics.endpointErrors[pathKey] || 0) + 1;
        }

        originalEnd.apply(res, args);
      };

      // Security and CORS Headers Checks
      const origin = req.headers.origin;
      if (origin) {
        if (isAllowedOrigin(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        } else {
          utils.logAudit("WARN", `Blocked CORS request from disallowed origin: ${origin}`);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "FORBIDDEN", message: "Cross-Origin request blocked for security." }));
          return;
        }
      }

      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-lister-api-key');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self';");

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Local Request Rate Limiting
      if (parsedUrl.pathname.startsWith('/api/') && !checkRateLimit(clientIp, parsedUrl.pathname)) {
        utils.logAudit("WARN", `Rate limit exceeded by ${clientIp} on ${parsedUrl.pathname}`);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "TOO_MANY_REQUESTS", message: "Rate limit exceeded. Please slow down." }));
        return;
      }
    
    // Authentication Check Middleware
    const openPaths = [
      '/', '/index.html',
      '/landing', '/landing.html',
      '/health',
      '/api/status',
      '/api/metrics',
      '/api/auth/google/login',
      '/api/auth/google/callback',
      '/api/billing/webhook',
      '/api/billing/mock-success'
    ];
    
    const isApiRoute = parsedUrl.pathname.startsWith('/api/');
    const isAssetRoute = parsedUrl.pathname.endsWith('.js') || parsedUrl.pathname.endsWith('.css') || parsedUrl.pathname.endsWith('.png');
    
    const user = getAuthenticatedUser(req);
    const isAuthRequired = config.getGOOGLE_CLIENT_ID() && !openPaths.includes(parsedUrl.pathname) && !isAssetRoute;
    
    if (isAuthRequired && !user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "UNAUTHORIZED", message: "Please log in using Google Sign-In." }));
      return;
    }
    
    // Serve Landing Page
    if (req.method === 'GET' && (parsedUrl.pathname === '/landing' || parsedUrl.pathname === '/landing.html')) {
      const landingPath = path.join(__dirname, 'public', 'landing.html');
      try {
        const content = fs.readFileSync(landingPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading landing page: ${err.message}`);
      }
      return;
    }

    // Serve Dashboard HTML
    if (req.method === 'GET' && (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html')) {
      const htmlPath = path.join(__dirname, 'public', 'index.html');
      try {
        const content = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading GUI: ${err.message}`);
      }
      return;
    }

    // API: Google OAuth Redirect Login
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/google/login') {
      const clientId = config.getGOOGLE_CLIENT_ID();
      const redirectUri = encodeURIComponent(config.getGOOGLE_REDIRECT_URI());
      if (!clientId) {
        // Auto-login mock for local dev
        const sessionId = crypto.randomBytes(32).toString('hex');
        const userObj = { email: "local-admin@lister.pro", isPremium: true };
        activeSessions.set(sessionId, { user: userObj, expiresAt: Date.now() + 86400000 });
        
        res.writeHead(302, {
          'Set-Cookie': `sessionId=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
          'Location': '/'
        });
        res.end();
        return;
      }
      
      const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=openid%20email%20profile`;
      res.writeHead(302, { 'Location': googleAuthUrl });
      res.end();
      return;
    }

    // API: Google OAuth Callback
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/google/callback') {
      const code = parsedUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(302, { 'Location': '/?error=code_missing' });
        res.end();
        return;
      }
      
      try {
        const tokenUrl = "https://oauth2.googleapis.com/token";
        const payload = new URLSearchParams({
          code,
          client_id: config.getGOOGLE_CLIENT_ID(),
          client_secret: config.getGOOGLE_CLIENT_SECRET(),
          redirect_uri: config.getGOOGLE_REDIRECT_URI(),
          grant_type: "authorization_code"
        }).toString();
        
        const tokenRes = await ebayClient.fetchWithRetry(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: payload
        });
        
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok) {
          throw new Error(`Google token exchange failed: ${JSON.stringify(tokenData)}`);
        }
        
        const accessToken = tokenData.access_token;
        const userInfoRes = await ebayClient.fetchWithRetry("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { "Authorization": `Bearer ${accessToken}` }
        });
        
        const userInfo = await userInfoRes.json();
        if (!userInfoRes.ok) {
          throw new Error(`Google userinfo failed: ${JSON.stringify(userInfo)}`);
        }
        
        const email = userInfo.email;
        const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
        const billingHistory = utils.readJsonFileSecure(billingDbPath, {});
        const isPremium = !!(billingHistory[email] && billingHistory[email].premium);
        
        const sessionId = crypto.randomBytes(32).toString('hex');
        const userObj = { email, name: userInfo.name, picture: userInfo.picture, isPremium };
        activeSessions.set(sessionId, { user: userObj, expiresAt: Date.now() + 86400000 });
        
        res.writeHead(302, {
          'Set-Cookie': `sessionId=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
          'Location': '/'
        });
        res.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Authentication Error: ${err.message}`);
      }
      return;
    }

    // API: Logout
    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/logout') {
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies.sessionId;
      if (sessionId) {
        activeSessions.delete(sessionId);
      }
      res.writeHead(200, {
        'Set-Cookie': `sessionId=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API: Session info
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        authenticated: !!user, 
        user: user || null,
        googleLoginEnabled: !!config.getGOOGLE_CLIENT_ID()
      }));
      return;
    }

    // API: Stripe Checkout Session creation
    if (req.method === 'POST' && parsedUrl.pathname === '/api/billing/create-checkout-session') {
      const stripeSecret = config.getSTRIPE_SECRET_KEY();
      if (!stripeSecret) {
        // Dev mock fallback if Stripe not configured
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: '/api/billing/mock-success' }));
        return;
      }
      
      try {
        const userEmail = user ? user.email : "customer@local.lister";
        const stripePayload = new URLSearchParams({
          "success_url": `http://localhost:${port}/?billing=success`,
          "cancel_url": `http://localhost:${port}/?billing=cancel`,
          "mode": "subscription",
          "customer_email": userEmail,
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][product_data][name]": "Lister Pro Premium Subscription",
          "line_items[0][price_data][unit_amount]": "2900", // $29.00
          "line_items[0][price_data][recurring][interval]": "month",
          "line_items[0][quantity]": "1"
        }).toString();
        
        const stripeRes = await ebayClient.fetchWithRetry("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Basic ${Buffer.from(stripeSecret + ':').toString('base64')}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: stripePayload
        });
        
        const stripeData = await stripeRes.json();
        if (!stripeRes.ok) {
          throw new Error(`Stripe API error: ${JSON.stringify(stripeData)}`);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: stripeData.url }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Stripe Mock Success
    if (req.method === 'GET' && parsedUrl.pathname === '/api/billing/mock-success') {
      if (user) {
        user.isPremium = true;
        const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
        const billingHistory = utils.readJsonFileSecure(billingDbPath, {});
        billingHistory[user.email] = { premium: true, subscriptionId: "mock-sub-12345" };
        utils.writeJsonFileSecure(billingDbPath, billingHistory);
      }
      res.writeHead(302, { 'Location': '/?billing=success' });
      res.end();
      return;
    }

    // API: Stripe Webhook
    if (req.method === 'POST' && parsedUrl.pathname === '/api/billing/webhook') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const signatureHeader = req.headers['stripe-signature'];
          const webhookSecret = config.getSTRIPE_WEBHOOK_SECRET();
          
          if (webhookSecret && signatureHeader) {
            const sigParts = signatureHeader.split(',');
            const timestampPart = sigParts.find(p => p.startsWith('t='));
            const signaturePart = sigParts.find(p => p.startsWith('v1='));
            
            if (!timestampPart || !signaturePart) throw new Error("Invalid signature headers");
            
            const timestamp = timestampPart.split('=')[1];
            const signature = signaturePart.split('=')[1];
            const signedPayload = `${timestamp}.${bodyData}`;
            
            const expectedSignature = crypto
              .createHmac('sha256', webhookSecret)
              .update(signedPayload)
              .digest('hex');
              
            if (signature !== expectedSignature) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Invalid Stripe signature" }));
              return;
            }
          }

          const event = JSON.parse(bodyData);
          const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
          const billingHistory = utils.readJsonFileSecure(billingDbPath, {});

          if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const email = session.customer_email || session.customer_details?.email;
            if (email) {
              billingHistory[email] = { premium: true, subscriptionId: session.subscription };
              utils.writeJsonFileSecure(billingDbPath, billingHistory);
              utils.logAudit("INFO", `Stripe Premium Activated for customer: ${email}`);
              for (const [sid, sess] of activeSessions.entries()) {
                if (sess.user.email === email) {
                  sess.user.isPremium = true;
                }
              }
            }
          } else if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            for (const email of Object.keys(billingHistory)) {
              if (billingHistory[email].subscriptionId === subscription.id) {
                billingHistory[email].premium = false;
                utils.writeJsonFileSecure(billingDbPath, billingHistory);
                utils.logAudit("INFO", `Stripe Premium Expired for customer: ${email}`);
                for (const [sid, sess] of activeSessions.entries()) {
                  if (sess.user.email === email) {
                    sess.user.isPremium = false;
                  }
                }
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: WooCommerce Cross-Post
    if (req.method === 'POST' && parsedUrl.pathname === '/api/publish/woocommerce') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData);
          const { sku, listing, imageUrls } = payload;
          
          const wcUrlStr = config.getWOOCOMMERCE_URL();
          const wcKey = config.getWOOCOMMERCE_KEY();
          const wcSecret = config.getWOOCOMMERCE_SECRET();
          
          if (!wcUrlStr || !wcKey || !wcSecret) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "WooCommerce not configured." }));
            return;
          }
          
          const wcPayload = {
            name: listing.title,
            type: "simple",
            regular_price: String(listing.suggestedPrice),
            description: listing.description,
            short_description: "Multichannel listing from eBay Lister",
            manage_stock: true,
            stock_quantity: 1,
            sku: sku,
            images: imageUrls.map(url => ({ src: url }))
          };
          
          const auth = Buffer.from(`${wcKey}:${wcSecret}`).toString('base64');
          const wcRes = await ebayClient.fetchWithRetry(`${wcUrlStr}/wp-json/wc/v3/products`, {
            method: "POST",
            headers: {
              "Authorization": `Basic ${auth}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(wcPayload)
          });
          
          const wcData = await wcRes.json();
          if (!wcRes.ok) {
            throw new Error(`WooCommerce API error: ${JSON.stringify(wcData)}`);
          }
          
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const item = history.find(i => i.sku === sku);
          if (item) {
            item.woocommerceId = String(wcData.id);
            utils.writeJsonFileSecure(config.historyPath, history);
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: wcData.id }));
        } catch (e) {
          crossPost.addToDlq("woocommerce", sku, listing, imageUrls || [], e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Etsy Cross-Post
    if (req.method === 'POST' && parsedUrl.pathname === '/api/publish/etsy') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData);
          const { sku, listing } = payload;
          
          const etsyShopId = config.getETSY_SHOP_ID();
          const etsyToken = config.getETSY_ACCESS_TOKEN();
          const etsyClientId = config.getEBAY_CLIENT_ID();
          
          if (!etsyShopId || !etsyToken) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Etsy shop settings not configured." }));
            return;
          }
          
          const etsyPayload = {
            quantity: 1,
            title: listing.title.slice(0, 140),
            description: listing.description,
            price: listing.suggestedPrice,
            who_made: "i_did",
            when_made: "made_to_order",
            taxonomy_id: 1,
            is_personalizable: false
          };
          
          const etsyRes = await ebayClient.fetchWithRetry(`https://api.etsy.com/v3/application/shops/${etsyShopId}/listings`, {
            method: "POST",
            headers: {
              "x-api-key": etsyClientId || "mock-etsy-client-id",
              "Authorization": `Bearer ${etsyToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(etsyPayload)
          });
          
          const etsyData = await etsyRes.json();
          if (!etsyRes.ok) {
            throw new Error(`Etsy API error: ${JSON.stringify(etsyData)}`);
          }
          
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const item = history.find(i => i.sku === sku);
          if (item) {
            item.etsyId = String(etsyData.listing_id);
            utils.writeJsonFileSecure(config.historyPath, history);
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: etsyData.listing_id }));
        } catch (e) {
          crossPost.addToDlq("etsy", sku, listing, [], e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Auto-Offer to Watchers
    if (req.method === 'POST' && parsedUrl.pathname === '/api/offers/auto-send') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData);
          const { sku, discountPercentage = 10 } = payload;
          
          if (!sku) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing required field: sku" }));
            return;
          }
          
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const item = history.find(i => i.sku === sku);
          
          if (!item) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "SKU not found" }));
            return;
          }
          
          if (item.status !== 'ACTIVE' || !item.listingId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Item is not active on eBay" }));
            return;
          }
          
          await ebayClient.refreshEbayAccessToken();
          const result = await ebayClient.sendOffersToWatchers(item.listingId, discountPercentage);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Poshmark & Mercari Export Details
    if (req.method === 'POST' && (parsedUrl.pathname === '/api/export/mercari' || parsedUrl.pathname === '/api/export/poshmark')) {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData);
          const { sku } = payload;
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const item = history.find(i => i.sku === sku);
          if (!item) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "SKU not found." }));
            return;
          }
          
          const platform = parsedUrl.pathname.includes('mercari') ? "Mercari" : "Poshmark";
          const exportData = {
            title: item.title,
            description: item.description,
            price: item.price,
            sku: item.sku,
            brand: item.brand || "Generic",
            suggestedTags: item.title.split(' ').slice(0, 3).join(', ')
          };
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            platform, 
            sku, 
            copyPaste: exportData,
            images: item.imageUrls || [] 
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Get Listings History
    if (req.method === 'GET' && parsedUrl.pathname === '/api/history') {
      const data = utils.readJsonFileSecure(config.historyPath, []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ listings: data, shopifyShopName: config.getSHOPIFY_SHOP_NAME() || null }));
      return;
    }

    // API: Health check
    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'ok', 
        timestamp: new Date().toISOString(), 
        version: '1.0.0'
      }));
      return;
    }

    // API: Get Status
    if (req.method === 'GET' && parsedUrl.pathname === '/api/status') {
      const circuitBreaker = ebayClient.getCircuitBreakerStatus();
      const diagnosticsOk = (() => {
        try {
          return config.runDiagnostics();
        } catch (e) {
          return false;
        }
      })();
      const statusInfo = {
        status: circuitBreaker.active ? "RATE_LIMITED" : "CONNECTED",
        circuitBreaker,
        diagnostics: diagnosticsOk ? "OK" : "FAILED",
        ebayAuthenticated: !!ebayClient.getAccessToken(),
        shopifyConnected: !!(config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN())
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusInfo));
      return;
    }

    // API: Get Metrics
    if (req.method === 'GET' && parsedUrl.pathname === '/api/metrics') {
      const activeLatencies = {};
      for (const [pathKey, list] of metrics.latencyData.entries()) {
        if (list.length > 0) {
          const sum = list.reduce((a, b) => a + b, 0);
          activeLatencies[pathKey] = {
            count: list.length,
            avgMs: Math.round(sum / list.length),
            minMs: Math.min(...list),
            maxMs: Math.max(...list)
          };
        }
      }

      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptime: Math.round(process.uptime()),
        totalRequests: metrics.totalRequests,
        endpointCounts: metrics.endpointCounts,
        endpointErrors: metrics.endpointErrors,
        latencies: activeLatencies,
        memoryUsage: {
          rss: Math.round(memory.rss / 1024 / 1024) + ' MB',
          heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + ' MB',
          heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + ' MB',
          external: Math.round(memory.external / 1024 / 1024) + ' MB'
        },
        cpuUsage: cpu,
        activeSockets: activeSockets.size,
        circuitBreakers: ebayClient.getCircuitBreakerStatus().domains
      }, null, 2));
      return;
    }

    // API: Get logs
    if (req.method === 'GET' && parsedUrl.pathname === '/api/logs') {
      try {
        const logFilePath = config.logPath;
        let logsText = "";
        if (fs.existsSync(logFilePath)) {
          const fileContent = fs.readFileSync(logFilePath, 'utf8');
          const lines = fileContent.split('\n').filter(l => l.trim().length > 0);
          const formattedLines = lines.slice(-50).map(line => {
            try {
              const log = JSON.parse(line);
              const tracePart = log.traceId ? ` [Trace: ${log.traceId}]` : '';
              const dataPart = log.data ? ` | Data: ${JSON.stringify(log.data)}` : '';
              return `[${log.timestamp}] [${log.level}]${tracePart} ${log.message}${dataPart}`;
            } catch (e) {
              return line;
            }
          });
          logsText = formattedLines.join('\n');
        } else {
          logsText = "No system logs found.";
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs: logsText }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Clear logs
    if ((req.method === 'POST' || req.method === 'DELETE') && parsedUrl.pathname === '/api/logs') {
      try {
        const logFilePath = config.logPath;
        fs.writeFileSync(logFilePath, '', 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }


    // API: Sync Listings from eBay
    if (req.method === 'POST' && parsedUrl.pathname === '/api/sync') {
      try {
        await ebayClient.syncListingsFromEbay();
        await runInventoryCrossSync();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // API: Analyze product photos
    if (req.method === 'POST' && parsedUrl.pathname === '/api/analyze') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          // Validate payload schema
          if (typeof payload !== 'object' || payload === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: must be a JSON object" }));
            return;
          }
          if (!payload.images || !Array.isArray(payload.images) || payload.images.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing or empty images array" }));
            return;
          }
          if (payload.barcode !== undefined && payload.barcode !== null && typeof payload.barcode !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid barcode: must be a string" }));
            return;
          }
          if (payload.notes !== undefined && payload.notes !== null && typeof payload.notes !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid notes: must be a string" }));
            return;
          }

          await ebayClient.refreshEbayAccessToken();

          let upcData = null;
          if (payload.barcode) {
            upcData = await ebayClient.lookupUPCOnEbay(payload.barcode);
          }

          const fileBuffers = [];
          const tempPaths = [];

          for (let i = 0; i < payload.images.length; i++) {
            const base64Data = payload.images[i].replace(/^data:image\/\w+;base64,/, "");
            const fileBuffer = Buffer.from(base64Data, 'base64');
            const tempFilename = `web-upload-${Date.now()}-${i}.jpg`;
            const tempFilePath = path.join(config.uploadTempDir, tempFilename);

            fs.writeFileSync(tempFilePath, fileBuffer);
            try {
              utils.verifyImageFile(tempFilePath);
            } catch (imgErr) {
              try { fs.unlinkSync(tempFilePath); } catch (e) {}
              tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Image validation failed: ${imgErr.message}` }));
              return;
            }
            
            const optimizedFilename = `opt-web-upload-${Date.now()}-${i}.jpg`;
            const optimizedFilePath = path.join(config.uploadTempDir, optimizedFilename);
            try {
              await utils.optimizeImageNative(tempFilePath, optimizedFilePath, 1600);
              try { fs.unlinkSync(tempFilePath); } catch (e) {}
              fileBuffers.push(fs.readFileSync(optimizedFilePath));
              tempPaths.push(optimizedFilePath);
            } catch (optErr) {
              utils.logAudit("WARN", `Failed to optimize image ${tempFilename}: ${optErr.message}`);
              fileBuffers.push(fileBuffer);
              tempPaths.push(tempFilePath);
            }
          }

          const listing = await geminiClient.runAIOrchestration(fileBuffers, tempPaths.map(p => path.basename(p)), payload.barcode, payload.notes, upcData);
          const categorySuggestions = await ebayClient.getCategorySuggestions(listing.title);
          const imageUrls = await uploadImagesConcurrently(tempPaths, 2);

          tempPaths.forEach(p => {
            try { fs.unlinkSync(p); } catch (e) {}
          });

          let stockPhotos = [];
          if (upcData && Array.isArray(upcData.stockImageUrls)) {
            stockPhotos = upcData.stockImageUrls;
          }
          if (stockPhotos.length === 0) {
            stockPhotos = await ebayClient.searchCatalogStockPhotos(listing.title);
          }

          const comps = await ebayClient.searchEbayComps(listing.title, listing.condition);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ listing, imageUrls, categorySuggestions, comps, stockPhotos }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Publish listing to eBay (and optional Shopify cross-post)
    if (req.method === 'POST' && parsedUrl.pathname === '/api/publish') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          // Validate publish schema
          if (typeof payload !== 'object' || payload === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: must be a JSON object" }));
            return;
          }

          const finalListing = payload.listing;
          const imageUrls = payload.imageUrls;

          if (!finalListing || typeof finalListing !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing or invalid listing object" }));
            return;
          }
          if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing or empty imageUrls array" }));
            return;
          }
          for (const url of imageUrls) {
            if (typeof url !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Invalid imageUrls element: must be a string URL" }));
              return;
            }
          }

          // Download and optimize external/stock images
          const finalImageUrls = [];
          for (const url of imageUrls) {
            if (url.startsWith('http') && !url.includes('tmpfiles.org') && !url.includes('file.io')) {
              const optUrl = await downloadAndOptimizeStockPhoto(url);
              finalImageUrls.push(optUrl);
            } else {
              finalImageUrls.push(url);
            }
          }

          // Sanitize listing object to conform to invariants
          geminiClient.validateAndFixListingSchema(finalListing);

          await ebayClient.refreshEbayAccessToken();
          
          const policies = await ebayClient.getOrCreateListingPolicies(
            payload.shippingOption || "USPS_GROUND",
            payload.returnOption || "NO_RETURNS",
            payload.immediatePayment !== false
          );

          const shippingTerms = config.getSELLER_SHIPPING_TERMS();
          const returnTerms = config.getSELLER_RETURN_TERMS();
          const footer = `
            <hr style="margin-top: 30px; border: 0; border-top: 1px solid #ccc;" />
            <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; margin-top: 20px; line-height: 1.6;">
              <h3 style="color: #004680; margin-bottom: 5px;">Seller Terms & Information</h3>
              <p><strong>Shipping:</strong> ${shippingTerms}</p>
              <p><strong>Returns:</strong> ${returnTerms}</p>
            </div>
          `;
          
          if (!finalListing.description.includes("Seller Terms & Information")) {
            finalListing.description += footer;
          }

          const sku = payload.sku || `${config.getSKU_PREFIX()}SKU-${Date.now()}`;

          const inventoryItem = {
            condition: finalListing.condition,
            availability: { shipToLocationAvailability: { quantity: 1 } },
            product: {
              title: finalListing.title.slice(0, 80),
              description: finalListing.description,
              brand: finalListing.brand,
              mpn: finalListing.model || "Does Not Apply",
              aspects: Object.fromEntries(Object.entries(finalListing.aspects).map(([k, v]) => [k, [v]])),
              imageUrls: finalImageUrls
            },
            packageWeightAndSize: {
              dimensions: {
                unit: "INCH",
                length: finalListing.packageLength,
                width: finalListing.packageWidth,
                height: finalListing.packageHeight
              },
              packageType: "PACKAGE",
              weight: {
                unit: "OUNCE",
                value: (finalListing.weightMajor * 16) + finalListing.weightMinor
              }
            }
          };

          await ebayClient.ebayRequest(`/inventory_item/${encodeURIComponent(sku)}`, "PUT", inventoryItem);

          const offerPayload = {
            sku: sku,
            marketplaceId: "EBAY_US",
            format: "FIXED_PRICE",
            availableQuantity: 1,
            includeCatalogProductDetails: true,
            merchantLocationKey: config.getEBAY_LOCATION_KEY(),
            categoryId: finalListing.categoryId,
            listingDescription: finalListing.description,
            listingDuration: "GTC",
            listingPolicies: {
              fulfillmentPolicyId: policies.fulfillmentId,
              paymentPolicyId: policies.paymentId,
              returnPolicyId: policies.returnId
            },
            pricingSummary: {
              price: { currency: "USD", value: String(finalListing.suggestedPrice) }
            }
          };

          const offerResponse = await ebayClient.ebayRequest("/offer", "POST", offerPayload);
          const publishResponse = await ebayClient.ebayRequest(`/offer/${offerResponse.offerId}/publish`, "POST");

          // Concurrent server-side cross-posting to Shopify, WooCommerce, and Etsy
          const crossPostPromises = [];
          const crossPostKeys = [];

          if (payload.crossPostShopify && config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()) {
            crossPostPromises.push(crossPostToShopify(finalListing, finalImageUrls, sku));
            crossPostKeys.push('shopify');
          }
          if (payload.crossPostWooCommerce && config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()) {
            crossPostPromises.push(crossPost.crossPostToWooCommerce(finalListing, finalImageUrls, sku));
            crossPostKeys.push('woocommerce');
          }
          if (payload.crossPostEtsy && config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN()) {
            crossPostPromises.push(crossPost.crossPostToEtsy(finalListing, sku));
            crossPostKeys.push('etsy');
          }

          const crossPostResults = {};
          let shopifyId = null;
          let woocommerceId = null;
          let etsyId = null;

          if (crossPostPromises.length > 0) {
            const results = await Promise.allSettled(crossPostPromises);
            results.forEach((resVal, idx) => {
              const platform = crossPostKeys[idx];
              if (resVal.status === 'fulfilled' && resVal.value) {
                crossPostResults[platform] = { success: true, id: resVal.value };
                if (platform === 'shopify') shopifyId = String(resVal.value);
                else if (platform === 'woocommerce') woocommerceId = String(resVal.value);
                else if (platform === 'etsy') etsyId = String(resVal.value);
              } else {
                const errMsg = resVal.reason?.message || "Unknown error";
                crossPostResults[platform] = { success: false, error: errMsg };
                utils.logAudit("ERROR", `${platform} concurrent cross-posting failed: ${errMsg}`);
              }
            });
          }

          utils.saveListingToHistory(
            sku,
            publishResponse.listingId,
            finalListing.title,
            finalListing.suggestedPrice,
            finalListing.categoryId,
            offerResponse.offerId,
            shopifyId,
            "ACTIVE",
            null,
            woocommerceId,
            etsyId
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            listingId: publishResponse.listingId,
            shopifyId,
            woocommerceId,
            etsyId,
            crossPostResults
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Save draft listing
    if (req.method === 'POST' && parsedUrl.pathname === '/api/save-draft') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          if (typeof payload !== 'object' || payload === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: must be a JSON object" }));
            return;
          }

          const finalListing = payload.listing;
          const imageUrls = payload.imageUrls;

          if (!finalListing || typeof finalListing !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing or invalid listing object" }));
            return;
          }

          geminiClient.validateAndFixListingSchema(finalListing);

          // Auto-Enriched UPC Sourcing from active comps if missing
          if (!finalListing.upc || finalListing.upc === "" || finalListing.upc === "Does Not Apply") {
            try {
              const compUpc = await ebayClient.findUpcFromComps(finalListing.title);
              if (compUpc) {
                finalListing.upc = compUpc;
              }
            } catch (e) {
              utils.logAudit("WARN", `Failed to auto-enrich UPC: ${e.message}`);
            }
          }

          // VeRO Brand Gatekeeper validation check
          let veroWarning = false;
          if (finalListing.brand) {
            const normalizedBrand = finalListing.brand.trim().toLowerCase();
            const veroBrands = config.getVERO_BRANDS();
            if (veroBrands.includes(normalizedBrand)) {
              veroWarning = true;
            }
          }
          finalListing.veroWarning = veroWarning;

          // Download and optimize external/stock images
          const finalImageUrls = [];
          if (imageUrls && Array.isArray(imageUrls)) {
            for (const url of imageUrls) {
              if (url.startsWith('http') && !url.includes('tmpfiles.org') && !url.includes('file.io')) {
                const optUrl = await downloadAndOptimizeStockPhoto(url);
                finalImageUrls.push(optUrl);
              } else {
                finalImageUrls.push(url);
              }
            }
          }

          const listingDetails = {
            ...finalListing,
            imageUrls: finalImageUrls
          };

          let sku = payload.sku;
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const existingIndex = sku ? history.findIndex(item => item.sku === sku) : -1;

          if (existingIndex !== -1) {
            // Update existing draft
            history[existingIndex].timestamp = new Date().toISOString();
            history[existingIndex].title = finalListing.title;
            history[existingIndex].price = parseFloat(finalListing.suggestedPrice);
            history[existingIndex].categoryId = finalListing.categoryId;
            history[existingIndex].brand = finalListing.brand || "Generic";
            history[existingIndex].veroWarning = veroWarning;
            history[existingIndex].listingDetails = listingDetails;
            utils.writeJsonFileSecure(config.historyPath, history);
            utils.logAudit("INFO", `Updated existing draft. SKU: ${sku}`);
          } else {
            // Create new draft
            const skuPrefix = config.getSKU_PREFIX();
            sku = `${skuPrefix}SKU-${Date.now()}`;
            utils.saveListingToHistory(sku, null, finalListing.title, finalListing.suggestedPrice, finalListing.categoryId, null, null, "DRAFT", listingDetails);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, sku, veroWarning, upc: finalListing.upc }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Publish draft listing
    if (req.method === 'POST' && parsedUrl.pathname === '/api/publish-draft') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          if (typeof payload !== 'object' || payload === null || !payload.sku || typeof payload.sku !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: Missing SKU field" }));
            return;
          }

          const history = utils.readJsonFileSecure(config.historyPath, []);
          const index = history.findIndex(item => item.sku === payload.sku);
          if (index === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Draft not found with specified SKU" }));
            return;
          }

          const item = history[index];
          if (item.status !== "DRAFT" || !item.listingDetails) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Item is not a valid draft listing" }));
            return;
          }

          const finalListing = item.listingDetails;
          const imageUrls = finalListing.imageUrls || [];

          // Download and optimize external/stock images
          const finalImageUrls = [];
          for (const url of imageUrls) {
            if (url.startsWith('http') && !url.includes('tmpfiles.org') && !url.includes('file.io')) {
              const optUrl = await downloadAndOptimizeStockPhoto(url);
              finalImageUrls.push(optUrl);
            } else {
              finalImageUrls.push(url);
            }
          }
          finalListing.imageUrls = finalImageUrls;

          // Format description terms if they are not already there
          const shippingTerms = config.getSELLER_SHIPPING_TERMS();
          const returnTerms = config.getSELLER_RETURN_TERMS();
          const footer = `
            <hr style="margin-top: 30px; border: 0; border-top: 1px solid #ccc;" />
            <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; margin-top: 20px; line-height: 1.6;">
              <h3 style="color: #004680; margin-bottom: 5px;">Seller Terms & Information</h3>
              <p><strong>Shipping:</strong> ${shippingTerms}</p>
              <p><strong>Returns:</strong> ${returnTerms}</p>
            </div>
          `;
          
          if (!finalListing.description.includes("Seller Terms & Information")) {
            finalListing.description += footer;
          }

          await ebayClient.refreshEbayAccessToken();
          
          const policies = await ebayClient.getOrCreateListingPolicies(
            payload.shippingOption || "USPS_GROUND",
            payload.returnOption || "NO_RETURNS",
            payload.immediatePayment !== false
          );

          const inventoryItem = {
            condition: finalListing.condition,
            availability: { shipToLocationAvailability: { quantity: 1 } },
            product: {
              title: finalListing.title.slice(0, 80),
              description: finalListing.description,
              brand: finalListing.brand,
              mpn: finalListing.model || "Does Not Apply",
              aspects: Object.fromEntries(Object.entries(finalListing.aspects || {}).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])),
              imageUrls: finalImageUrls
            },
            packageWeightAndSize: {
              dimensions: {
                unit: "INCH",
                length: finalListing.packageLength,
                width: finalListing.packageWidth,
                height: finalListing.packageHeight
              },
              packageType: "PACKAGE",
              weight: {
                unit: "OUNCE",
                value: (finalListing.weightMajor * 16) + finalListing.weightMinor
              }
            }
          };

          await ebayClient.ebayRequest(`/inventory_item/${encodeURIComponent(payload.sku)}`, "PUT", inventoryItem);

          const offerPayload = {
            sku: payload.sku,
            marketplaceId: "EBAY_US",
            format: "FIXED_PRICE",
            availableQuantity: 1,
            includeCatalogProductDetails: true,
            merchantLocationKey: config.getEBAY_LOCATION_KEY(),
            categoryId: finalListing.categoryId,
            listingDescription: finalListing.description,
            listingDuration: "GTC",
            listingPolicies: {
              fulfillmentPolicyId: policies.fulfillmentId,
              paymentPolicyId: policies.paymentId,
              returnPolicyId: policies.returnId
            },
            pricingSummary: {
              price: { currency: "USD", value: String(finalListing.suggestedPrice) }
            }
          };

          const offerResponse = await ebayClient.ebayRequest("/offer", "POST", offerPayload);
          const publishResponse = await ebayClient.ebayRequest(`/offer/${offerResponse.offerId}/publish`, "POST");

          // Concurrent server-side cross-posting to Shopify, WooCommerce, and Etsy
          const crossPostPromises = [];
          const crossPostKeys = [];

          if (payload.crossPostShopify && config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()) {
            crossPostPromises.push(crossPostToShopify(finalListing, finalImageUrls, payload.sku));
            crossPostKeys.push('shopify');
          }
          if (payload.crossPostWooCommerce && config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()) {
            crossPostPromises.push(crossPost.crossPostToWooCommerce(finalListing, finalImageUrls, payload.sku));
            crossPostKeys.push('woocommerce');
          }
          if (payload.crossPostEtsy && config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN()) {
            crossPostPromises.push(crossPost.crossPostToEtsy(finalListing, payload.sku));
            crossPostKeys.push('etsy');
          }

          const crossPostResults = {};
          let shopifyId = null;
          let woocommerceId = null;
          let etsyId = null;

          if (crossPostPromises.length > 0) {
            const results = await Promise.allSettled(crossPostPromises);
            results.forEach((resVal, idx) => {
              const platform = crossPostKeys[idx];
              if (resVal.status === 'fulfilled' && resVal.value) {
                crossPostResults[platform] = { success: true, id: resVal.value };
                if (platform === 'shopify') shopifyId = String(resVal.value);
                else if (platform === 'woocommerce') woocommerceId = String(resVal.value);
                else if (platform === 'etsy') etsyId = String(resVal.value);
              } else {
                const errMsg = resVal.reason?.message || "Unknown error";
                crossPostResults[platform] = { success: false, error: errMsg };
                utils.logAudit("ERROR", `${platform} concurrent draft cross-posting failed: ${errMsg}`);
              }
            });
          }

          // Update entry in history
          item.listingId = publishResponse.listingId;
          item.offerId = offerResponse.offerId;
          item.shopifyId = shopifyId || item.shopifyId || null;
          item.woocommerceId = woocommerceId || item.woocommerceId || null;
          item.etsyId = etsyId || item.etsyId || null;
          item.status = "ACTIVE";
          
          utils.writeJsonFileSecure(config.historyPath, history);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            listingId: publishResponse.listingId,
            shopifyId,
            woocommerceId,
            etsyId,
            crossPostResults
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: End live listing
    if (req.method === 'POST' && parsedUrl.pathname === '/api/end-listing') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          if (typeof payload !== 'object' || payload === null || !payload.sku || typeof payload.sku !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: Missing SKU field" }));
            return;
          }
          await ebayClient.refreshEbayAccessToken();
          const listingId = await ebayClient.endListingOnEbay(payload.sku, payload.offerId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, listingId }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end("404 Not Found");
    });
  });

  // Track active connections for graceful shutdown
  server.on('connection', socket => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  const gracefulShutdown = () => {
    utils.logAudit("INFO", "Shutting down web GUI server gracefully...");
    server.close(() => {
      utils.logAudit("INFO", "Web server closed.");
      process.exit(0);
    });
    for (const socket of activeSockets) {
      socket.destroy();
    }
  };

  if (!shutdownRegistered) {
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    shutdownRegistered = true;
  }

  // Strictly bind only to localhost loopback '127.0.0.1' for security
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 eBay Personal Lister GUI server started!`);
    console.log(`🔗 Access Dashboard: http://127.0.0.1:${port}`);
    console.log(`======================================================\n`);
    
    // Clean old files on startup
    utils.cleanOldTempFiles();
    
    // Start automated background inventory cross-sync check every 5 minutes
    const syncInterval = setInterval(async () => {
      try {
        await ebayClient.syncListingsFromEbay();
        await runInventoryCrossSync();
        await crossPost.processPendingSyncsDlq();
        utils.cleanOldTempFiles();
      } catch (err) {
        utils.logAudit("ERROR", `Background inventory sync failed: ${err.message}`);
      }
    }, 5 * 60 * 1000);
    if (syncInterval && typeof syncInterval.unref === 'function') {
      syncInterval.unref();
    }

    // Run once on startup asynchronously
    runInventoryCrossSync().catch(err => {
      utils.logAudit("ERROR", `Initial startup inventory sync failed: ${err.message}`);
    });
    crossPost.processPendingSyncsDlq().catch(err => {
      utils.logAudit("ERROR", `Initial startup DLQ processing failed: ${err.message}`);
    });

    const command = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    exec(`${command} http://127.0.0.1:${port}`);
  });

  return server;
}

/**
 * Uploads file buffer to primary temporary image host (tmpfiles.org).
 * @param {string} filename - Filename string.
 * @param {Buffer} fileBuffer - Image buffer.
 * @param {string} boundary - Multipart boundary string.
 * @returns {Promise<string>} Uploaded file URL.
 */
async function uploadToTmpFiles(filename, fileBuffer, boundary) {
  const header = `--${boundary}\nContent-Disposition: form-data; name="file"; filename="${filename}"\nContent-Type: image/jpeg\n\n`;
  const footer = `\n--${boundary}--\n`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8')
  ]);

  const response = await ebayClient.fetchWithRetry("https://tmpfiles.org/api/v1/upload", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyBuffer
  });

  const resData = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(resData));
  return resData.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
}

/**
 * Uploads file buffer to fallback temporary image host (file.io).
 * @param {string} filename - Filename string.
 * @param {Buffer} fileBuffer - Image buffer.
 * @param {string} boundary - Multipart boundary string.
 * @returns {Promise<string>} Uploaded file URL.
 */
async function uploadToFileIo(filename, fileBuffer, boundary) {
  const header = `--${boundary}\nContent-Disposition: form-data; name="file"; filename="${filename}"\nContent-Type: image/jpeg\n\n`;
  const footer = `\n--${boundary}--\n`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8')
  ]);

  const response = await ebayClient.fetchWithRetry("https://file.io/?expires=1d", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyBuffer
  });

  const resData = await response.json();
  if (!response.ok || !resData.success) throw new Error(JSON.stringify(resData));
  return resData.link;
}

/**
 * Downloads a remote image, optimizes it natively (squaring/centering), and uploads it.
 * @param {string} url - Remote stock photo URL.
 * @returns {Promise<string>} New optimized remote image URL.
 */
async function downloadAndOptimizeStockPhoto(url) {
  utils.logAudit("INFO", `Downloading and optimizing remote stock photo: ${url}`);
  const tempFilename = `stock-download-${Date.now()}-${Math.round(Math.random() * 1000)}.jpg`;
  const tempFilePath = path.join(config.uploadTempDir, tempFilename);
  const optFilePath = path.join(config.uploadTempDir, `opt-${tempFilename}`);
  
  try {
    const res = await ebayClient.fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`Failed to download stock photo, status ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(tempFilePath, buffer);
    
    // Validate image format/signature
    utils.verifyImageFile(tempFilePath);
    
    // Optimize
    await utils.optimizeImageNative(tempFilePath, optFilePath, 1600);
    
    // Upload optimized
    const uploadedUrl = await uploadImage(optFilePath);
    
    // Cleanup
    try { fs.unlinkSync(tempFilePath); } catch (e) {}
    try { fs.unlinkSync(optFilePath); } catch (e) {}
    
    return uploadedUrl;
  } catch (err) {
    utils.logAudit("WARN", `Failed to download/optimize stock photo: ${err.message}. Using original URL.`);
    // Cleanup on error
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
    try { if (fs.existsSync(optFilePath)) fs.unlinkSync(optFilePath); } catch (e) {}
    return url;
  }
}

/**
 * Uploads local image to temp image host, using fallback if primary fails.
 * @param {string} imagePath - Absolute path to local image.
 * @returns {Promise<string>} File URL.
 */
async function uploadImage(imagePath) {
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
  const filename = path.basename(imagePath);
  const fileBuffer = fs.readFileSync(imagePath);

  try {
    return await uploadToTmpFiles(filename, fileBuffer, boundary);
  } catch (err) {
    utils.logAudit("WARN", `Primary image host failed for ${filename}: ${err.message}. Trying file.io fallback...`);
    try {
      return await uploadToFileIo(filename, fileBuffer, boundary);
    } catch (err2) {
      utils.logAudit("ERROR", `All upload options failed.`);
      throw new Error(`All temporary image hosts failed to upload ${filename}.\nDetails:\n[Primary]: ${err.message}\n[Fallback]: ${err2.message}`);
    }
  }
}

/**
 * Uploads multiple images with a concurrency limit.
 * @param {string[]} imagePaths - Paths of images to upload.
 * @param {number} [limit=2] - Max concurrent uploads.
 * @returns {Promise<string[]>} Uploaded URLs.
 */
async function uploadImagesConcurrently(imagePaths, limit = 2) {
  const results = new Array(imagePaths.length);
  let index = 0;
  
  async function worker() {
    while (index < imagePaths.length) {
      const myIndex = index++;
      const imgPath = imagePaths[myIndex];
      results[myIndex] = await uploadImage(imgPath);
    }
  }
  
  const workers = [];
  const numWorkers = Math.min(limit, imagePaths.length);
  for (let i = 0; i < numWorkers; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// Cross-posting delegation to crossPost.js
const crossPost = require('./crossPost');
const crossPostToShopify = crossPost.crossPostToShopify;
function resetRateLimits() {
  rateLimits.clear();
  analyzeRateLimits.clear();
}

module.exports = {
  startWebGuiServer,
  crossPostToShopify,
  resetRateLimits
};

if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 45900;
  startWebGuiServer(port);
}
