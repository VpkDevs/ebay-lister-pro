/**
 * @file routes/admin.js
 * @description Express router for administration and utility endpoints (system diagnostics, logs streaming, config editing, templates, and metrics).
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('../config');
const utils = require('../utils');
const ebayClient = require('../ebayClient');
const activeSessions = require('../lib/sessions');

const router = express.Router();

// Helper: Custom API clients metrics counter (needs to be available for metrics route)
// We will export a metrics tracker or hook it to the global process or a local metrics object.
const serverMetrics = {
  totalRequests: 0,
  endpointCounts: {},
  endpointErrors: {},
  latencyData: new Map()
};

// Expose metric trackers for global middlewares to record
global.serverMetrics = serverMetrics;

function createClientError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sanitizeEnvValueForSave(key, value) {
  const raw = value === undefined || value === null ? '' : String(value);
  if (/[\r\n]/.test(raw)) {
    throw createClientError(`Invalid value for ${key}: line breaks are not allowed in .env values.`);
  }
  if (raw.includes('\0')) {
    throw createClientError(`Invalid value for ${key}: null bytes are not allowed.`);
  }
  return raw.trim();
}

async function runDiagnosticsHealth() {
  const reports = {};

  const checkFolderWritable = (dir) => {
    try {
      const testFile = path.join(dir, `.health-check-${Date.now()}`);
      fs.writeFileSync(testFile, 'ok', 'utf8');
      fs.unlinkSync(testFile);
      return { status: "OK" };
    } catch (e) {
      return { status: "ERROR", message: e.message };
    }
  };

  const checkFileIntegrity = (filePath) => {
    if (!fs.existsSync(filePath)) return { status: "OK", message: "File does not exist yet (clean start)" };
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim()) JSON.parse(content);
      return { status: "OK" };
    } catch (e) {
      return { status: "CORRUPTED", error: e.message };
    }
  };

  const checkDbLocks = (filePath) => {
    const lockPath = `${filePath}.lock`;
    if (fs.existsSync(lockPath)) {
      try {
        const stats = fs.statSync(lockPath);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs > 60000) {
          return { status: "STUCK_LOCK_DETECTED", ageMs };
        }
        return { status: "LOCKED_ACTIVE" };
      } catch (e) {
        return { status: "ERROR", error: e.message };
      }
    }
    return { status: "OK" };
  };

  reports.storage = {
    scratch: checkFolderWritable(path.join(process.cwd(), 'scratch')),
    uploads: checkFolderWritable(config.uploadTempDir),
    data: checkFolderWritable(path.join(process.cwd(), 'data'))
  };

  reports.database = {
    historyIntegrity: checkFileIntegrity(config.historyPath),
    historyLockStatus: checkDbLocks(config.historyPath),
    dlqIntegrity: checkFileIntegrity(config.dlqPath),
    dlqLockStatus: checkDbLocks(config.dlqPath)
  };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memoryUsage = process.memoryUsage();
  const cpus = os.cpus();
  reports.system = {
    freeMemoryPercentage: ((freeMem / totalMem) * 100).toFixed(2) + "%",
    heapUsedMB: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2),
    heapTotalMB: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2),
    rssMB: (memoryUsage.rss / 1024 / 1024).toFixed(2),
    cpuCores: cpus.length,
    cpuModel: cpus[0]?.model || "unknown",
    loadAvg: os.loadavg(),
    uptimeSeconds: process.uptime().toFixed(0)
  };

  const cbStatus = ebayClient.getCircuitBreakerStatus();
  reports.circuitBreakers = cbStatus.domains || {};

  const isHealthy = reports.storage.scratch.status === "OK" &&
                    reports.storage.uploads.status === "OK" &&
                    reports.storage.data.status === "OK" &&
                    reports.database.historyIntegrity.status === "OK" &&
                    reports.database.dlqIntegrity.status === "OK" &&
                    reports.database.historyLockStatus.status !== "STUCK_LOCK_DETECTED" &&
                    reports.database.dlqLockStatus.status !== "STUCK_LOCK_DETECTED";

  return {
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    details: reports
  };
}

// API: Get templates
router.get('/api/templates', (req, res) => {
  const templatesPath = path.join(process.cwd(), 'data', 'templates.json');
  let templates = [];
  try {
    if (fs.existsSync(templatesPath)) {
      templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
    }
  } catch (e) {}
  res.json(templates);
});

// API: Save template
router.post('/api/templates', (req, res, next) => {
  const templatesPath = path.join(process.cwd(), 'data', 'templates.json');
  try {
    const payload = req.body;
    if (!payload.name || !payload.listing) {
      return res.status(400).json({ error: "Missing name or listing in template payload" });
    }
    let templates = [];
    try {
      if (fs.existsSync(templatesPath)) {
        templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
      }
    } catch (e) {}
    const existingIdx = templates.findIndex(t => t.name === payload.name);
    if (existingIdx !== -1) {
      templates[existingIdx] = payload;
    } else {
      templates.push(payload);
    }
    fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2), 'utf8');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// API: Delete template
router.delete('/api/templates', (req, res) => {
  const name = req.query.name;
  if (!name) {
    return res.status(400).json({ error: "Missing template name" });
  }
  const templatesPath = path.join(process.cwd(), 'data', 'templates.json');
  let templates = [];
  try {
    if (fs.existsSync(templatesPath)) {
      templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
    }
  } catch (e) {}
  templates = templates.filter(t => t.name !== name);
  fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2), 'utf8');
  res.json({ success: true });
});

// API: Update Repricer Configuration
router.post('/api/repricer', async (req, res, next) => {
  try {
    const { sku, priceFloor, priceCap, priceLocked } = req.body;
    if (!sku) {
      return res.status(400).json({ error: "Missing required parameter: sku" });
    }

    const history = utils.readJsonFileSecure(config.historyPath, []);
    const existingIndex = history.findIndex(item => item.sku === sku);
    if (existingIndex === -1) {
      return res.status(404).json({ error: "SKU not found in history" });
    }

    let parsedFloor = null;
    if (priceFloor !== undefined && priceFloor !== null && priceFloor !== '') {
      parsedFloor = parseFloat(priceFloor);
      if (isNaN(parsedFloor) || parsedFloor < 0) {
        return res.status(400).json({ error: "Invalid priceFloor: must be a positive number" });
      }
    }

    let parsedCap = null;
    if (priceCap !== undefined && priceCap !== null && priceCap !== '') {
      parsedCap = parseFloat(priceCap);
      if (isNaN(parsedCap) || parsedCap < 0) {
        return res.status(400).json({ error: "Invalid priceCap: must be a positive number" });
      }
    }

    if (parsedFloor !== null && parsedCap !== null && parsedFloor > parsedCap) {
      return res.status(400).json({ error: "priceFloor cannot be greater than priceCap" });
    }

    // Update settings
    history[existingIndex].priceFloor = parsedFloor;
    history[existingIndex].priceCap = parsedCap;
    history[existingIndex].priceLocked = !!priceLocked;
    history[existingIndex].timestamp = new Date().toISOString();

    utils.writeJsonFileSecure(config.historyPath, history);
    utils.logAudit("INFO", `Updated repricer config for SKU ${sku}: Floor=${parsedFloor}, Cap=${parsedCap}, Locked=${!!priceLocked}`);

    res.json({
      success: true,
      sku,
      priceFloor: parsedFloor,
      priceCap: parsedCap,
      priceLocked: !!priceLocked
    });
  } catch (err) {
    next(err);
  }
});

// API: Run Repricer Tool Immediately
router.post('/api/repricer/run', async (req, res, next) => {
  try {
    await ebayClient.runDailyRepricer();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// API: Auto-Offer to Watchers
router.post('/api/offers/auto-send', async (req, res, next) => {
  try {
    const { sku, discountPercentage = 10 } = req.body;

    if (!sku) {
      return res.status(400).json({ error: "Missing required field: sku" });
    }

    const history = utils.readJsonFileSecure(config.historyPath, []);
    const item = history.find(i => i.sku === sku);

    if (!item) {
      return res.status(404).json({ error: "SKU not found" });
    }

    if (item.status !== 'ACTIVE' || !item.listingId) {
      return res.status(400).json({ error: "Item is not active on eBay" });
    }

    await ebayClient.refreshEbayAccessToken();
    const result = await ebayClient.sendOffersToWatchers(item.listingId, discountPercentage);

    res.json({ success: true, result });
  } catch (e) {
    next(e);
  }
});

// API: Health check
router.get('/health', async (req, res) => {
  try {
    const report = await runDiagnosticsHealth();
    res.status(report.status === 'ok' ? 200 : 500).json(report);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// API: Get Status
router.get('/api/status', async (req, res, next) => {
  try {
    const crossPost = require('../crossPost');
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
      shopifyConnected: !!(config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()),
      woocommerceConnected: !!(config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()),
      etsyConnected: !!(config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN() && process.env.ETSY_CLIENT_ID),
      dlq: await crossPost.getDlqSummary()
    };
    res.json(statusInfo);
  } catch (err) {
    next(err);
  }
});

// API: Get Metrics
router.get('/api/metrics', (req, res) => {
  const activeLatencies = {};
  for (const [pathKey, list] of serverMetrics.latencyData.entries()) {
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

  res.json({
    uptime: Math.round(process.uptime()),
    totalRequests: serverMetrics.totalRequests,
    endpointCounts: serverMetrics.endpointCounts,
    endpointErrors: serverMetrics.endpointErrors,
    latencies: activeLatencies,
    memoryUsage: {
      rss: Math.round(memory.rss / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + ' MB',
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + ' MB',
      external: Math.round(memory.external / 1024 / 1024) + ' MB'
    },
    cpuUsage: cpu,
    activeSockets: req.app.get('activeSocketsCount') || 0,
    circuitBreakers: ebayClient.getCircuitBreakerStatus().domains
  });
});

// API: Get logs
router.get('/api/logs', (req, res) => {
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
    res.json({ logs: logsText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Clear logs
router.delete('/api/logs', (req, res) => {
  try {
    const logFilePath = config.logPath;
    fs.writeFileSync(logFilePath, '', 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/api/logs', (req, res) => {
  try {
    const logFilePath = config.logPath;
    fs.writeFileSync(logFilePath, '', 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Real-time logs SSE stream
router.get('/api/logs/stream', (req, res) => {
  const logPath = config.logPath;
  if (!fs.existsSync(logPath)) {
    try { fs.writeFileSync(logPath, '', 'utf8'); } catch (e) {}
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');

  let filePosition = 0;
  if (fs.existsSync(logPath)) {
    filePosition = fs.statSync(logPath).size;
  }

  const watcher = fs.watch(logPath, (eventType) => {
    if (eventType === 'change') {
      try {
        const stats = fs.statSync(logPath);
        if (stats.size > filePosition) {
          const fd = fs.openSync(logPath, 'r');
          const bufferSize = stats.size - filePosition;
          const buffer = Buffer.alloc(bufferSize);
          fs.readSync(fd, buffer, 0, bufferSize, filePosition);
          fs.closeSync(fd);
          filePosition = stats.size;

          const lines = buffer.toString('utf8').split('\n').filter(l => l.trim().length > 0);
          for (const line of lines) {
            res.write(`data: ${line}\n\n`);
          }
        } else if (stats.size < filePosition) {
          filePosition = stats.size;
        }
      } catch (e) {
        // silent catch
      }
    }
  });

  req.on('close', () => {
    watcher.close();
  });
});

// API: Get configuration keys
router.get('/api/config', (req, res) => {
  try {
    const configData = {
      EBAY_CLIENT_ID: config.getEBAY_CLIENT_ID() || "",
      EBAY_CLIENT_SECRET: config.getEBAY_CLIENT_SECRET() || "",
      EBAY_REFRESH_TOKEN: config.getEBAY_REFRESH_TOKEN() || "",
      EBAY_RUNAME: config.getEBAY_RUNAME() || "",
      EBAY_LOCATION_KEY: config.getEBAY_LOCATION_KEY() || "default",
      EBAY_FULFILLMENT_POLICY_ID: config.getEBAY_FULFILLMENT_POLICY_ID() || "",
      EBAY_PAYMENT_POLICY_ID: config.getEBAY_PAYMENT_POLICY_ID() || "",
      EBAY_RETURN_POLICY_ID: config.getEBAY_RETURN_POLICY_ID() || "",
      SHOPIFY_SHOP_NAME: config.getSHOPIFY_SHOP_NAME() || "",
      SHOPIFY_ACCESS_TOKEN: config.getSHOPIFY_ACCESS_TOKEN() || "",
      WOOCOMMERCE_URL: config.getWOOCOMMERCE_URL() || "",
      WOOCOMMERCE_KEY: config.getWOOCOMMERCE_KEY() || "",
      WOOCOMMERCE_SECRET: config.getWOOCOMMERCE_SECRET() || "",
      ETSY_SHOP_ID: config.getETSY_SHOP_ID() || "",
      ETSY_ACCESS_TOKEN: config.getETSY_ACCESS_TOKEN() || "",
      ETSY_CLIENT_ID: process.env.ETSY_CLIENT_ID || "",
      API_KEY: config.getAPI_KEY() || "",
      GEMINI_API_KEY: config.getGEMINI_API_KEY() || "",
      WATERMARK_TEXT: config.getWATERMARK_TEXT() || "",
      SKU_PREFIX: config.getSKU_PREFIX() || "AUTO-",
      DEFAULT_PRICING_STRATEGY: config.getDEFAULT_PRICING_STRATEGY() || "MARKET",
      DEFAULT_SHIPPING_OPTION: config.getDEFAULT_SHIPPING_OPTION() || "USPS_GROUND",
      DEFAULT_RETURN_OPTION: config.getDEFAULT_RETURN_OPTION() || "NO_RETURNS",
      DEFAULT_IMMEDIATE_PAYMENT: config.getDEFAULT_IMMEDIATE_PAYMENT(),
      SELLER_SHIPPING_TERMS: config.getSELLER_SHIPPING_TERMS() || "",
      SELLER_RETURN_TERMS: config.getSELLER_RETURN_TERMS() || ""
    };
    res.json(configData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Save configuration keys
router.post('/api/config/save', (req, res, next) => {
  try {
    const payload = req.body;
    if (typeof payload !== 'object' || payload === null) {
      return res.status(400).json({ error: "Invalid payload format" });
    }

    const allowedKeys = [
      'API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REDIRECT_URI', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
      'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN', 'EBAY_LOCATION_KEY',
      'EBAY_RUNAME', 'EBAY_FULFILLMENT_POLICY_ID', 'EBAY_PAYMENT_POLICY_ID', 'EBAY_RETURN_POLICY_ID',
      'SHOPIFY_SHOP_NAME', 'SHOPIFY_ACCESS_TOKEN',
      'WOOCOMMERCE_URL', 'WOOCOMMERCE_KEY', 'WOOCOMMERCE_SECRET',
      'ETSY_SHOP_ID', 'ETSY_ACCESS_TOKEN', 'ETSY_CLIENT_ID',
      'WATERMARK_TEXT', 'SKU_PREFIX', 'DEFAULT_PRICING_STRATEGY',
      'DEFAULT_SHIPPING_OPTION', 'DEFAULT_RETURN_OPTION', 'DEFAULT_IMMEDIATE_PAYMENT',
      'SELLER_SHIPPING_TERMS', 'SELLER_RETURN_TERMS'
    ];

    for (const key of Object.keys(payload)) {
      if (!allowedKeys.includes(key)) {
        return res.status(400).json({ error: `Unauthorized or invalid config key: ${key}` });
      }
    }

    let envContent = '';
    if (fs.existsSync(config.envPath)) {
      envContent = fs.readFileSync(config.envPath, 'utf8');
    }

    let lines = envContent.split(/\r?\n/);

    for (const key of Object.keys(payload)) {
      const val = sanitizeEnvValueForSave(key, payload[key]);
      process.env[key] = val;

      const index = lines.findIndex(l => {
        const trimmed = l.trim();
        return trimmed.startsWith(`${key}=`) || trimmed.startsWith(`#${key}=`);
      });

      if (index !== -1) {
        lines[index] = `${key}=${val}`;
      } else {
        lines.push(`${key}=${val}`);
      }
    }

    fs.writeFileSync(config.envPath, lines.join('\n'), 'utf8');
    utils.logAudit("INFO", `Updated config keys: ${Object.keys(payload).join(', ')}`);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// API: Sync Listings from eBay
router.post('/api/sync', async (req, res, next) => {
  try {
    await ebayClient.syncListingsFromEbay();
    // Background cross sync will run triggered by webServer.js in the main file
    // Here we can run it asynchronously if needed or just return success
    if (global.triggerInventoryCrossSync) {
      global.triggerInventoryCrossSync();
    }
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// API: Reset circuit breaker
router.post('/api/circuit-breaker/reset', (req, res, next) => {
  try {
    const { domain } = req.body;
    if (!domain) {
      return res.status(400).json({ error: "Missing required field: domain" });
    }
    ebayClient.resetCircuitBreaker(domain);
    res.json({ success: true, message: `Circuit breaker reset for ${domain}` });
  } catch (err) {
    next(err);
  }
});

// API: Bulk Action on Listings
router.post('/api/history/bulk-action', async (req, res, next) => {
  try {
    const { action, skus, platforms } = req.body;
    if (!action || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({ error: "Missing required fields: action and non-empty skus array" });
    }

    if (action === 'delete') {
      let deletedCount = 0;
      for (const sku of skus) {
        const deleted = utils.removeListing(sku);
        if (deleted) deletedCount++;
      }
      utils.logAudit("INFO", `Bulk deleted ${deletedCount} of ${skus.length} SKUs`);
      return res.json({ success: true, count: deletedCount });
    }

    if (action === 'crosspost') {
      if (!Array.isArray(platforms) || platforms.length === 0) {
        return res.status(400).json({ error: "crosspost action requires a non-empty platforms array" });
      }
      const history = utils.readJsonFileSecure(config.historyPath, []);
      const crossPost = require('../crossPost');
      const results = {};

      for (const sku of skus) {
        const item = history.find(i => i.sku === sku);
        if (!item) continue;
        results[sku] = {};

        const finalListing = {
          title: item.title,
          description: item.description,
          suggestedPrice: item.price || item.suggestedPrice || 29.99,
          condition: item.condition || "NEW"
        };
        const finalImageUrls = item.imageUrls || [];

        for (const platform of platforms) {
          try {
            if (platform === 'shopify') {
              const shopId = await crossPost.crossPostToShopify(finalListing, finalImageUrls, sku);
              results[sku].shopify = { success: true, id: shopId };
            } else if (platform === 'woocommerce') {
              const wcId = await crossPost.crossPostToWooCommerce(finalListing, finalImageUrls, sku);
              results[sku].woocommerce = { success: true, id: wcId };
            } else if (platform === 'etsy') {
              const etsyId = await crossPost.crossPostToEtsy(finalListing, sku);
              results[sku].etsy = { success: true, id: etsyId };
            }
          } catch (e) {
            results[sku][platform] = { success: false, error: e.message };
          }
        }
      }
      return res.json({ success: true, results });
    }

    if (action === 'end') {
      const history = utils.readJsonFileSecure(config.historyPath, []);
      let endedCount = 0;
      for (const sku of skus) {
        const item = history.find(i => i.sku === sku);
        if (item && item.status === 'ACTIVE') {
          try {
            await ebayClient.endListingOnEbay(sku, item.offerId);
            item.status = "ENDED";
            endedCount++;
          } catch (e) {
            utils.logAudit("ERROR", `Failed to end eBay listing for SKU ${sku} in bulk: ${e.message}`);
          }
        }
      }
      if (endedCount > 0) {
        utils.writeJsonFileSecure(config.historyPath, history);
      }
      return res.json({ success: true, count: endedCount });
    }

    res.status(400).json({ error: "Invalid action. Use delete, end, or crosspost." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
