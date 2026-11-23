/**
 * @file lib/feedbackEngine.js
 * @description Automated eBay buyer feedback engine with configurable trigger rules,
 *   randomized message templates, exclusion filters, and a dedup cache.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const utils = require('../utils');

const DEFAULT_TEMPLATES = [
  'Great buyer! Fast payment, smooth transaction. A++++',
  'Excellent buyer, highly recommended! Thank you!',
  'Perfect transaction, great communication. 5 stars!',
  'Wonderful buyer, paid immediately. Thank you very much!',
  'Top-rated buyer, great to work with. A++ transaction!',
  'Super fast payment, pleasure to deal with. Highly recommended!',
  'Outstanding buyer! Smooth and easy transaction. Thanks!',
];

class FeedbackEngine {
  constructor(ebayClient, options = {}) {
    if (!ebayClient) throw new Error('FeedbackEngine: ebayClient is required');

    this._ebayClient = ebayClient;
    this._trigger = options.trigger || 'paid';
    this._delayDays = options.delayDays != null ? options.delayDays : 0;
    this._templates = Array.isArray(options.templates) && options.templates.length > 0
      ? options.templates : DEFAULT_TEMPLATES;
    this._exclusions = {
      minFeedbackScore: options.exclusions?.minFeedbackScore || 0,
      skipIfReturnFiled: options.exclusions?.skipIfReturnFiled !== false,
    };
    this._pollIntervalMs = options.pollIntervalMs || 30 * 60 * 1000;
    this._scratchDir = options.scratchDir || path.join(process.cwd(), 'scratch');
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this._dedupeFile = path.join(this._scratchDir, 'feedback-sent.json');
    this._intervalHandle = null;
    this._lastPickedIndices = [];
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
      await this.processPendingFeedback();
    } catch (err) {
      utils.logAudit('ERROR', `FeedbackEngine: unhandled error: ${err.message}`);
    }
  }

  async processPendingFeedback() {
    let feedbackLeft = 0;
    let skipped = 0;
    let errors = 0;

    let ordersFile = path.join(this._dataDir, 'sold-orders.json');
    if (!fs.existsSync(ordersFile)) {
      ordersFile = path.join(this._scratchDir, 'sold-orders.json');
    }

    let orders;
    try {
      orders = fs.existsSync(ordersFile) ? utils.readJsonFileSecure(ordersFile, []) : [];
    } catch (err) {
      return { feedbackLeft: 0, skipped: 0, errors: 1 };
    }

    const sentOrderIds = this._loadDedup();
    const now = Date.now();
    const delayMs = this._delayDays * 86400000;

    for (const order of orders) {
      const orderId = String(order.orderId || order.id || '');
      if (!orderId) { skipped++; continue; }
      if (sentOrderIds.has(orderId)) { skipped++; continue; }
      if (!this._isTriggerMet(order, now, delayMs)) { skipped++; continue; }

      if (this._exclusions.minFeedbackScore > 0) {
        const score = parseInt(order.buyerFeedbackScore || order.feedbackScore || 0, 10);
        if (score < this._exclusions.minFeedbackScore) { skipped++; continue; }
      }
      if (this._exclusions.skipIfReturnFiled && order.hasReturnCase) { skipped++; continue; }

      try {
        const comment = this.getRandomTemplate();
        const buyerId = order.buyerId || order.buyer?.username || '';
        await this._leaveFeedback(orderId, buyerId, comment);
        sentOrderIds.add(orderId);
        feedbackLeft++;
      } catch (err) {
        errors++;
      }
    }

    if (feedbackLeft > 0) {
      this._saveDedup(sentOrderIds);
    }

    return { feedbackLeft, skipped, errors };
  }

  _isTriggerMet(order, now, delayMs) {
    switch (this._trigger) {
      case 'paid': {
        const paidAt = order.paidAt || order.createdAt || order.soldAt;
        if (!paidAt) return false;
        return now - new Date(paidAt).getTime() >= delayMs;
      }
      case 'positive_received': {
        return !!order.buyerLeftPositive;
      }
      case 'days_after_shipment': {
        const shippedAt = order.shippedAt || order.trackingAddedAt;
        if (!shippedAt) return false;
        return now - new Date(shippedAt).getTime() >= delayMs;
      }
      default:
        return false;
    }
  }

  async _leaveFeedback(orderId, buyerId, comment) {
    if (typeof this._ebayClient.leaveFeedback === 'function') {
      await this._ebayClient.leaveFeedback(orderId, buyerId, comment);
      return;
    }
    utils.logAudit('INFO', `FeedbackEngine (WOULD LEAVE): orderId=${orderId} buyerId=${buyerId} comment="${comment}"`);
  }

  getRandomTemplate() {
    const available = this._templates
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => !this._lastPickedIndices.includes(i));

    const pool = available.length > 0 ? available : this._templates.map((t, i) => ({ t, i }));
    const pick = pool[Math.floor(Math.random() * pool.length)];

    this._lastPickedIndices.push(pick.i);
    if (this._lastPickedIndices.length > 2) this._lastPickedIndices.shift();

    return pick.t;
  }

  _loadDedup() {
    try {
      if (!fs.existsSync(this._scratchDir)) fs.mkdirSync(this._scratchDir, { recursive: true });
      const data = utils.readJsonFileSecure(this._dedupeFile, { sentOrderIds: [] });
      return new Set(data.sentOrderIds || []);
    } catch (_) {
      return new Set();
    }
  }

  _saveDedup(sentSet) {
    try {
      const arr = Array.from(sentSet);
      const trimmed = arr.length > 10000 ? arr.slice(arr.length - 10000) : arr;
      utils.writeJsonFileSecure(this._dedupeFile, { sentOrderIds: trimmed, savedAt: new Date().toISOString() });
    } catch (err) {}
  }
}

module.exports = { FeedbackEngine, DEFAULT_TEMPLATES };
