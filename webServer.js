/**
 * @file webServer.js
 * @description Boots the main Express web application, manages connection tracking for graceful shutdowns,
 * runs background automated tasks/cron syncs, and handles inventory reconciliation between eBay and Shopify.
 */

'use strict';

const http = require('http');
const { exec } = require('child_process');
const config = require('./config');
const utils = require('./utils');
const ebayClient = require('./ebayClient');
const crossPost = require('./crossPost');
const app = require('./app');

let shutdownRegistered = false;
let activeRequests = 0;

// Track active connections/sockets for graceful shutdown
const activeSockets = new Set();

/**
 * Periodically reconciles inventory levels between eBay and Shopify.
 * If an item is sold/removed on one channel, updates the other channel dynamically.
 */
async function runInventoryCrossSync() {
  const shopName = config.getSHOPIFY_SHOP_NAME();
  const accessToken = config.getSHOPIFY_ACCESS_TOKEN();
  const ebayToken = ebayClient.getAccessToken();

  if (!ebayToken) {
    return;
  }

  const history = await utils.readJsonFileSecureAsync(config.historyPath, []);
  let historyChanged = false;

  const activeItems = history.filter(item => item.status === "ACTIVE");
  if (activeItems.length === 0) return;

  utils.logAudit("INFO", `Starting background inventory cross-sync for ${activeItems.length} active listings...`);

  const CHUNK_SIZE = 5;
  for (let i = 0; i < activeItems.length; i += CHUNK_SIZE) {
    const chunk = activeItems.slice(i, i + CHUNK_SIZE);

    await Promise.all(chunk.map(async (item) => {
      let itemChanged = false;

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
              itemChanged = true;
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
                  itemChanged = true;
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
      if (item.listingId && item.status !== "ENDED") {
        try {
          const offerRes = await ebayClient.ebayRequest(`/offer?sku=${encodeURIComponent(item.sku)}`, "GET");
          const offers = offerRes.offers || [];
          const activeOffer = offers.find(o => o.sku === item.sku && o.status === "LISTED");

          if (!activeOffer) {
            utils.logAudit("INFO", `eBay SKU ${item.sku} is no longer active/listed on eBay. Reflecting to Shopify product ${item.shopifyId}...`);
            item.status = "ENDED";
            itemChanged = true;

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

      if (itemChanged) {
        historyChanged = true;
      }
    }));
  }

  if (historyChanged) {
    await utils.writeJsonFileSecureAsync(config.historyPath, history);
  }
}

/**
 * Starts the local loopback web server for the Express application.
 * @param {number} [port] - Server listen port (defaults to config.getPORT()).
 * @returns {http.Server} The running http.Server instance.
 */
function startWebGuiServer(port = config.getPORT()) {
  const server = http.createServer(app);

  // Monitor active requests for graceful shutdown
  app.use((req, res, next) => {
    activeRequests++;
    const decrementRequests = () => activeRequests--;
    res.on('finish', decrementRequests);
    res.on('close', decrementRequests);
    next();
  });

  // Track active connection sockets
  server.on('connection', socket => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  // Share active sockets count with the admin router via app settings
  app.set('activeSocketsCount', activeSockets.size);
  setInterval(() => {
    app.set('activeSocketsCount', activeSockets.size);
  }, 1000).unref();

  let isShuttingDown = false;
  const gracefulShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    utils.logAudit("INFO", `Shutting down web GUI server gracefully... Active requests: ${activeRequests}`);

    server.close(() => {
      utils.logAudit("INFO", "Web server closed.");
      process.exit(0);
    });

    if (activeRequests === 0) {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      process.exit(0);
    }

    const forceShutdownTimeout = setTimeout(() => {
      utils.logAudit("WARN", `Graceful shutdown timeout reached. Force destroying ${activeSockets.size} remaining sockets...`);
      for (const socket of activeSockets) {
        socket.destroy();
      }
      process.exit(0);
    }, 5000);

    if (forceShutdownTimeout && typeof forceShutdownTimeout.unref === 'function') {
      forceShutdownTimeout.unref();
    }
  };

  if (!shutdownRegistered) {
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    shutdownRegistered = true;
  }

  // Handle port-in-use and other listen errors gracefully
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ FATAL: Port ${port} is already in use by another process.`);
      console.error(`   Run: netstat -ano | findstr :${port}  to find and kill it, then restart.`);
    } else {
      console.error(`\n❌ FATAL: Server error — ${err.message}`);
    }
    process.exit(1);
  });

  // Bind server loopback listener
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 eBay Personal Lister GUI server started!`);
    console.log(`🔗 Access Dashboard: http://127.0.0.1:${port}`);
    console.log(`======================================================\n`);

    // Clean old files on startup
    utils.cleanOldTempFiles();

    if (process.env.NODE_ENV !== 'test') {
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

      // Hook run once on startup asynchronously
      runInventoryCrossSync().catch(err => {
        utils.logAudit("ERROR", `Initial startup inventory sync failed: ${err.message}`);
      });
      crossPost.processPendingSyncsDlq().catch(err => {
        utils.logAudit("ERROR", `Initial startup DLQ processing failed: ${err.message}`);
      });

      // Launch default system browser to show dashboard
      const command = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      exec(`${command} http://127.0.0.1:${port}`);
    }
  });

  // Expose immediate execution triggers globally
  global.triggerInventoryCrossSync = () => {
    runInventoryCrossSync().catch(err => {
      utils.logAudit("ERROR", `Manually triggered inventory cross sync failed: ${err.message}`);
    });
  };

  return server;
}

module.exports = {
  startWebGuiServer,
  crossPostToShopify: crossPost.crossPostToShopify,
  resetRateLimits: () => app.resetRateLimits()
};

if (require.main === module) {
  startWebGuiServer(config.getPORT());
}
