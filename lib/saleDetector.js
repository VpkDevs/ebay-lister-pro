/**
 * @file lib/saleDetector.js
 * @description Cross-channel sale detection daemon. Polls eBay Orders REST API for
 *   newly fulfilled orders and automatically delists the sold item from all other
 *   connected channels (Shopify, Etsy, WooCommerce) via the crossPost module.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const utils = require('../utils');

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SCRATCH_DIR = path.join(process.cwd(), 'scratch');

class SaleDetector {
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
      this._processedOrderIds = new Set();
    }
  }

  _saveCache() {
    try {
      const ids = Array.from(this._processedOrderIds);
      const trimmed = ids.length > 5000 ? ids.slice(ids.length - 5000) : ids;
      utils.writeJsonFileSecure(this._cacheFile, { processedOrderIds: trimmed, savedAt: new Date().toISOString() });
    } catch (err) {}
  }

  start() {
    if (this._intervalHandle) return;
    this._runSafely();
    this._intervalHandle = setInterval(() => this._runSafely(), this._pollIntervalMs);
    if (this._intervalHandle.unref) this._intervalHandle.unref();
  }

  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }

  async _runSafely() {
    try {
      await this.pollAndProcess();
    } catch (err) {
      utils.logAudit('ERROR', `SaleDetector: unhandled error in polling cycle: ${err.message}`);
    }
  }

  async pollAndProcess() {
    const sales = await this.pollEbaySales();
    if (sales.length === 0) return { salesDetected: 0, delistResults: [] };

    const delistResults = [];
    for (const saleEvent of sales) {
      if (this._processedOrderIds.has(saleEvent.orderId)) continue;
      const results = await this.delistFromOtherChannels(saleEvent);
      delistResults.push({ saleEvent, results });
      this._processedOrderIds.add(saleEvent.orderId);
    }

    this._saveCache();
    return { salesDetected: sales.length, delistResults };
  }

  async pollEbaySales() {
    if (typeof this._ebayClient.getCircuitBreakerStatus === 'function') {
      const cbStatus = this._ebayClient.getCircuitBreakerStatus('api.ebay.com');
      if (cbStatus && cbStatus.active) {
        return [];
      }
    }

    try {
      const since = new Date(Date.now() - this._pollIntervalMs * 2).toISOString();
      const endpoint = `/order?filter=creationdate:[${since}..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS|FULFILLED}&limit=100`;
      const response = await this._ebayClient.ebayRequest(endpoint, 'GET');
      const orders = (response && response.orders) ? response.orders : [];

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
      return sales;
    } catch (err) {
      return [];
    }
  }

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

  async _delistFromChannel(saleEvent, channel) {
    if (!this._crossPost) return false;
    if (typeof this._crossPost.delistItem === 'function') {
      await this._crossPost.delistItem(saleEvent.sku, channel);
      return true;
    }
    const methodName = `delistFrom${channel.charAt(0).toUpperCase() + channel.slice(1)}`;
    if (typeof this._crossPost[methodName] === 'function') {
      await this._crossPost[methodName](saleEvent.sku);
      return true;
    }
    return false;
  }
}

module.exports = { SaleDetector };
