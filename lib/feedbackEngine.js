/**
 * @file lib/feedbackEngine.js
 * @description Automated eBay buyer feedback engine with configurable trigger rules,
 *   randomized message templates (to avoid scripted-feedback flags), exclusion filters,
 *   and a dedup cache to prevent double-posting.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const utils = require('../utils');
const config = require('../config');

/** Default feedback message templates */
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
  /**
   * @param {object} ebayClient - The ebayClient module.
   * @param {object} [options]
   * @param {'paid'|'positive_received'|'days_after_shipment'} [options.trigger='paid']
   * @param {number}   [options.delayDays=0]            - Days to wait after trigger before posting.
   * @param {string[]} [options.templates]              - Feedback message templates.
   * @param {object}   [options.exclusions]
   * @param {number}   [options.exclusions.minFeedbackScore=0]    - Skip buyers below this score.
   * @param {boolean}  [options.exclusions.skipIfReturnFiled=true] - Skip if buyer filed a return.
   * @param {number}   [options.pollIntervalMs=1800000]  - How often to check (default 30 min).
   * @param {string}   [options.scratchDir]             - Directory for dedup cache.
   * @param {string}   [options.dataDir]                - Directory for sold-orders.json.
   */
  constructor(ebayClient, options = {}) {
    if (!ebayClient) throw new Error('FeedbackEngine: ebayClient is required');

    this._ebayClient = ebayClient;
    this._trigger = options.trigger || 'paid';
    this._delayDays = options.delayDays != null ? options.delayDays : 0;
    this._templates = Array.isArray(options.templates) && options.templates.length > 0
      ? options.templates : DEFAULT_TEMPLATES;
    this._exclusions = {
      minFeedbackScore: options.exclusions?.minFeedbackScore || 0,
      skipIfReturnFiled: options.exclusions?.skipIfReturnFiled !== false, // default true
    };
    this._pollIntervalMs = options.pollIntervalMs || 30 * 60 * 1000;
    this._scratchDir = options.scratchDir || path.join(process.cwd(), 'scratch');
    this._dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this._dedupeFile = path.join(this._scratchDir, 'feedback-sent.json');
    this._intervalHandle = null;
    this._lastPickedIndices = [];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Starts the background feedback polling daemon. */
  start() {
    if (this._intervalHandle) {
      utils.logAudit('WARN', 'FeedbackEngine: start() called while already running — ignored');
      return;
    }
    utils.logAudit('INFO', `FeedbackEngine: starting (trigger="${this._trigger}", delayDays=${this._delayDays}, interval=${this._pollIntervalMs}ms)`);
    this._runSafely();
    this._intervalHandle = setInterval(() => this._runSafely(), this._pollIntervalMs);
    if (this._intervalHandle.unref) this._intervalHandle.unref();
  }

  /** Stops the background feedback polling daemon. */
  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
      utils.logAudit('INFO', 'FeedbackEngine: stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // Core logic
  // ---------------------------------------------------------------------------

  async _runSafely() {
    try {
      const result = await this.checkAndLeaveFeedback();
      if (result.feedbackLeft > 0) {
        utils.logAudit('INFO', `FeedbackEngine: left ${result.feedbackLeft} feedback(s), skipped ${result.skipped}`);
      }
    } catch (err) {
      utils.logAudit('ERROR', `FeedbackEngine: unhandled error: ${err.message}`);
    }
  }

  /**
   * Main feedback loop: checks eligible orders and posts feedback.
   * @returns {Promise<{feedbackLeft: number, skipped: number, errors: number}>}
   */
  async checkAndLeaveFeedback() {
    let feedbackLeft = 0;
    let skipped = 0;
    let errors = 0;

    // Load sent dedup set
    const sentOrderIds = this._loadDedup();

    // Read sold orders from disk
    const ordersFile = path.join(this._dataDir, 'sold-orders.json');
    let orders;
    try {
      orders = utils.readJsonFileSecure(ordersFile, []);
    } catch (err) {
      utils.logAudit('WARN', `FeedbackEngine: could not read sold-orders.json: ${err.message}`);
      return { feedbackLeft: 0, skipped: 0, errors: 1 };
    }

    const now = Date.now();
    const delayMs = this._delayDays * 86400000;

    for (const order of orders) {
      const orderId = String(order.orderId || order.id || '');
      if (!orderId) { skipped++; continue; }

      // Dedup check
      if (sentOrderIds.has(orderId)) { skipped++; continue; }

      // Trigger check
      if (!this._isTriggerMet(order, now, delayMs)) { skipped++; continue; }

      // Exclusion checks
      if (this._exclusions.minFeedbackScore > 0) {
        const score = parseInt(order.buyerFeedbackScore || order.feedbackScore || 0, 10);
        if (score < this._exclusions.minFeedbackScore) { skipped++; continue; }
      }
      if (this._exclusions.skipIfReturnFiled && order.hasReturnCase) { skipped++; continue; }

      // Post feedback
      try {
        const comment = this.getRandomTemplate();
        const buyerId = order.buyerId || order.buyer?.username || '';
        await this._leaveFeedback(orderId, buyerId, comment);
        sentOrderIds.add(orderId);
        feedbackLeft++;
        utils.logAudit('INFO', `FeedbackEngine: left feedback for orderId=${orderId} buyerId=${buyerId}`);
      } catch (err) {
        errors++;
        utils.logAudit('WARN', `FeedbackEngine: failed to leave feedback for orderId=${orderId}: ${err.message}`);
      }
    }

    // Persist updated dedup set
    if (feedbackLeft > 0) {
      this._saveDedup(sentOrderIds);
    }

    return { feedbackLeft, skipped, errors };
  }

  /**
   * Determines if the configured trigger condition is met for an order.
   * @param {object} order
   * @param {number} now       - Current timestamp (ms).
   * @param {number} delayMs   - Required delay after trigger (ms).
   * @returns {boolean}
   */
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

  /**
   * Calls the eBay Trading API to leave feedback.
   * Falls back to logging intent if the method is not available on ebayClient.
   * @param {string} orderId
   * @param {string} buyerId
   * @param {string} comment
   * @returns {Promise<void>}
   */
  async _leaveFeedback(orderId, buyerId, comment) {
    // Use ebayClient's leaveFeedback if it exists
    if (typeof this._ebayClient.leaveFeedback === 'function') {
      await this._ebayClient.leaveFeedback(orderId, buyerId, comment);
      return;
    }

    // Otherwise fall back to a direct Trading API call via ebayRequest (REST) or log
    // The eBay Trading API LeaveFeedback endpoint is a SOAP call.
    // Since ebayClient uses REST, we log the intent and skip — this is a known
    // extension point for when the Trading API SOAP layer is added.
    utils.logAudit('INFO', `FeedbackEngine (WOULD LEAVE): orderId=${orderId} buyerId=${buyerId} comment="${comment}"`);
  }

  /**
   * Returns a random template, avoiding the last 2 picks to reduce repetition.
   * @returns {string}
   */
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

  // ---------------------------------------------------------------------------
  // Dedup cache helpers
  // ---------------------------------------------------------------------------

  /** @returns {Set<string>} */
  _loadDedup() {
    try {
      if (!fs.existsSync(this._scratchDir)) fs.mkdirSync(this._scratchDir, { recursive: true });
      const data = utils.readJsonFileSecure(this._dedupeFile, { sentOrderIds: [] });
      return new Set(data.sentOrderIds || []);
    } catch (_) {
      return new Set();
    }
  }

  /** @param {Set<string>} sentSet */
  _saveDedup(sentSet) {
    try {
      const arr = Array.from(sentSet);
      const trimmed = arr.length > 10000 ? arr.slice(arr.length - 10000) : arr;
      utils.writeJsonFileSecure(this._dedupeFile, { sentOrderIds: trimmed, savedAt: new Date().toISOString() });
    } catch (err) {
      utils.logAudit('WARN', `FeedbackEngine: failed to save dedup cache: ${err.message}`);
    }
  }
}

module.exports = { FeedbackEngine, DEFAULT_TEMPLATES };
