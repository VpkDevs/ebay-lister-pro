/**
 * @file lib/saleDetector.js
 * @description Cross-channel sale detection daemon. Polls eBay Orders REST API for
 *   newly fulfilled orders and automatically delists the sold item from all other
 *   connected channels (Shopify, Etsy, WooCommerce) via the crossPost module.
 *   Runs as a background service inside the watcher daemon process.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const utils = require('../utils');
const config = require('../config');

/** Default poll interval: 5 minutes */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Scratch cache file to deduplicate processed orders across restarts */
const DEFAULT_SCRATCH_DIR = path.join(process.cwd(), 'scratch');

class SaleDetector {
  /**
   * @param {object} ebayClient   - The ebayClient module (requires ebayRequest, getCircuitBreakerStatus, endListingOnEbay).
   * @param {object} crossPost    - The crossPost module (used to delist from Shopify/Etsy/WooCommerce).
   * @param {object} [options]
   * @param {number} [options.pollIntervalMs=300000] - How often to poll for new sales.
   * @param {string} [options.scratchDir]            - Directory for the dedup cache file.
   */
  constructor(ebayClient, crossPost, options = {}) {
    if (!ebayClient || typeof ebayClient.ebayRequest !== 'function') {
      throw new Error('SaleDetector: ebayClient with ebayRequest method is required');
    }
    this._ebayClient = ebayClient;
    this._crossPost = crossPost;
    this._pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this._scratchDir = options.scratchDir || DEFAULT_SCRATCH_DIR;
    this._cacheFile = path.join(this._scratchDir, 'sale-detector-cache.json');
    this._intervalHandle = null;
    this._processedOrderIds = new Set();
    this._loadCache();
  }

  // ---------------------------------------------------------------------------
  // Cache I/O
  // ---------------------------------------------------------------------------

  /** Loads the persisted dedup cache into memory. */
  _loadCache() {
    try {
      if (!fs.existsSync(this._scratchDir)) {
        fs.mkdirSync(this._scratchDir, { recursive: true });
      }
      const data = utils.readJsonFileSecure(this._cacheFile, { processedOrderIds: [] });
      if (Array.isArray(data.processedOrderIds)) {
        this._processedOrderIds = new Set(data.processedOrderIds);
      }
    } catch (err) {
      utils.logAudit('WARN', `SaleDetector: failed to load cache: ${err.message}`);
      this._processedOrderIds = new Set();
    }
  }

  /** Persists the dedup cache to disk. Non-fatal on failure. */
  _saveCache() {
    try {
      // Keep the set bounded to the last 5000 order IDs to prevent unbounded growth
      const ids = Array.from(this._processedOrderIds);
      const trimmed = ids.length > 5000 ? ids.slice(ids.length - 5000) : ids;
      utils.writeJsonFileSecure(this._cacheFile, { processedOrderIds: trimmed, savedAt: new Date().toISOString() });
    } catch (err) {
      utils.logAudit('WARN', `SaleDetector: failed to save cache: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts the background polling daemon.
   * @returns {void}
   */
  start() {
    if (this._intervalHandle) {
      utils.logAudit('WARN', 'SaleDetector: start() called while already running — ignored');
      return;
    }
    utils.logAudit('INFO', `SaleDetector: starting with poll interval ${this._pollIntervalMs}ms`);
    // Run once immediately, then on interval
    this._runSafely();
    this._intervalHandle = setInterval(() => this._runSafely(), this._pollIntervalMs);
    // Allow the Node process to exit without waiting for this interval
    if (this._intervalHandle.unref) this._intervalHandle.unref();
  }

  /**
   * Stops the background polling daemon.
   * @returns {void}
   */
  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
      utils.logAudit('INFO', 'SaleDetector: stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // Core logic
  // ---------------------------------------------------------------------------

  /** Safely wraps the polling cycle so errors never crash the daemon. */
  async _runSafely() {
    try {
      await this.pollAndProcess();
    } catch (err) {
      utils.logAudit('ERROR', `SaleDetector: unhandled error in polling cycle: ${err.message}`);
    }
  }

  /**
   * Runs one complete poll-and-process cycle.
   * @returns {Promise<{salesDetected: number, delistResults: Array}>}
   */
  async pollAndProcess() {
    const sales = await this.pollEbaySales();
    if (sales.length === 0) return { salesDetected: 0, delistResults: [] };

    const delistResults = [];
    for (const saleEvent of sales) {
      if (this._processedOrderIds.has(saleEvent.orderId)) continue;

      utils.logAudit('INFO', `SaleDetector: NEW SALE detected — orderId=${saleEvent.orderId} sku=${saleEvent.sku} title="${saleEvent.title}"`);
      const results = await this.delistFromOtherChannels(saleEvent);
      delistResults.push({ saleEvent, results });
      this._processedOrderIds.add(saleEvent.orderId);
    }

    this._saveCache();
    return { salesDetected: sales.length, delistResults };
  }

  /**
   * Polls eBay Orders API for orders created in the last `pollIntervalMs` window.
   * Returns normalized sale events ready for delisting.
   * @returns {Promise<Array<{orderId, sku, ebayItemId, title, salePrice, soldAt, channel}>>}
   */
  async pollEbaySales() {
    // Check circuit breaker before making API call
    const cbStatus = this._ebayClient.getCircuitBreakerStatus('api.ebay.com');
    if (cbStatus && cbStatus.active) {
      utils.logAudit('WARN', `SaleDetector: eBay circuit breaker is OPEN (${cbStatus.cooldownRemainingSeconds}s remaining) — skipping poll`);
      return [];
    }

    try {
      // eBay Orders API: fetch orders created in the last poll window
      const since = new Date(Date.now() - this._pollIntervalMs * 2).toISOString(); // 2× window for overlap safety
      const endpoint = `/order?filter=creationdate:[${since}..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS|FULFILLED}&limit=100`;
      const response = await this._ebayClient.ebayRequest(endpoint, 'GET');
      const orders = (response && response.orders) ? response.orders : [];

      /** @type {Array} */
      const sales = [];
      for (const order of orders) {
        for (const lineItem of (order.lineItems || [])) {
          sales.push({
            orderId: order.orderId,
            sku: lineItem.sku || '',
            ebayItemId: lineItem.legacyItemId || lineItem.lineItemId || '',
            title: lineItem.title || '',
            salePrice: parseFloat((lineItem.lineItemCost && lineItem.lineItemCost.value) || 0),
            soldAt: order.creationDate || new Date().toISOString(),
            channel: 'ebay',
          });
        }
      }

      if (sales.length > 0) {
        utils.logAudit('INFO', `SaleDetector: polled eBay Orders API — found ${sales.length} line items in ${orders.length} orders`);
      }
      return sales;
    } catch (err) {
      utils.logAudit('ERROR', `SaleDetector: eBay Orders API poll failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Delists a sold item from all non-eBay channels in parallel.
   * @param {{sku: string, ebayItemId: string, title: string}} saleEvent
   * @returns {Promise<Array<{channel, success, error}>>}
   */
  async delistFromOtherChannels(saleEvent) {
    const channels = ['shopify', 'etsy', 'woocommerce', 'mercari', 'poshmark'];
    const tasks = channels.map(channel => this._delistFromChannel(saleEvent, channel));
    const settled = await Promise.allSettled(tasks);

    return settled.map((result, idx) => ({
      channel: channels[idx],
      success: result.status === 'fulfilled' && result.value === true,
      error: result.status === 'rejected' ? result.reason?.message : null,
    }));
  }

  /**
   * Attempts to delist from a single channel using the crossPost module.
   * @param {object} saleEvent
   * @param {string} channel
   * @returns {Promise<boolean>}
   */
  async _delistFromChannel(saleEvent, channel) {
    if (!this._crossPost) return false;

    // Try the crossPost module's delistItem method if it exists
    if (typeof this._crossPost.delistItem === 'function') {
      try {
        await this._crossPost.delistItem(saleEvent.sku, channel);
        utils.logAudit('INFO', `SaleDetector: delisted SKU=${saleEvent.sku} from ${channel}`);
        return true;
      } catch (err) {
        utils.logAudit('WARN', `SaleDetector: failed to delist SKU=${saleEvent.sku} from ${channel}: ${err.message}`);
        throw err;
      }
    }

    // Fallback: look for a channel-specific method (e.g. delistFromShopify)
    const methodName = `delistFrom${channel.charAt(0).toUpperCase() + channel.slice(1)}`;
    if (typeof this._crossPost[methodName] === 'function') {
      try {
        await this._crossPost[methodName](saleEvent.sku);
        utils.logAudit('INFO', `SaleDetector: delisted SKU=${saleEvent.sku} from ${channel} via ${methodName}`);
        return true;
      } catch (err) {
        utils.logAudit('WARN', `SaleDetector: ${methodName} failed for SKU=${saleEvent.sku}: ${err.message}`);
        throw err;
      }
    }

    // Channel not implemented — skip silently
    return false;
  }
}

module.exports = { SaleDetector };
