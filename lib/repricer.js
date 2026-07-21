/**
 * @file lib/repricer.js
 * @description AI-powered competitive repricer with IQR-based outlier resistance,
 *   per-item floor/ceiling guards, and a transparent audit log.
 *   Runs as a scheduled background service, extending (not replacing) the
 *   existing runDailyRepricer in ebayClient.js with superior pricing logic.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const utils = require('../utils');
const config = require('../config');

/** Default run interval: 6 hours */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Minimum allowed margin above COGS (15%) */
const DEFAULT_MIN_MARGIN_PCT = 0.15;

class Repricer {
  /**
   * @param {object} ebayClient       - The ebayClient module (requires searchEbayComps, ebayRequest).
   * @param {string} listingsPath     - Absolute path to the listings JSON file.
   * @param {object} [options]
   * @param {number} [options.minMarginPct=0.15]     - Minimum required profit margin fraction (e.g. 0.15 = 15%).
   * @param {number} [options.runIntervalMs=21600000] - How often to reprice.
   * @param {number} [options.priceMultiplier=1.0]   - IQR median multiplier (1.0 = match market, 0.95 = undercut 5%).
   * @param {string} [options.scratchDir]            - Directory for the reprice log.
   */
  constructor(ebayClient, listingsPath, options = {}) {
    if (!ebayClient || typeof ebayClient.searchEbayComps !== 'function') {
      throw new Error('Repricer: ebayClient with searchEbayComps method is required');
    }
    if (!listingsPath || typeof listingsPath !== 'string') {
      throw new Error('Repricer: listingsPath must be a non-empty string');
    }

    this._ebayClient = ebayClient;
    this._listingsPath = listingsPath;
    this._minMarginPct = options.minMarginPct != null ? options.minMarginPct : DEFAULT_MIN_MARGIN_PCT;
    this._runIntervalMs = options.runIntervalMs || DEFAULT_INTERVAL_MS;
    this._priceMultiplier = options.priceMultiplier != null ? options.priceMultiplier : 1.0;
    this._scratchDir = options.scratchDir || path.join(process.cwd(), 'scratch');
    this._logFile = path.join(this._scratchDir, 'reprice-log.json');
    this._intervalHandle = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Starts the scheduled repricing daemon.
   * @returns {void}
   */
  start() {
    if (this._intervalHandle) {
      utils.logAudit('WARN', 'Repricer: start() called while already running — ignored');
      return;
    }
    utils.logAudit('INFO', `Repricer: starting with interval ${this._runIntervalMs}ms, minMargin=${(this._minMarginPct * 100).toFixed(0)}%`);
    // Run one cycle immediately at startup
    this._runSafely();
    this._intervalHandle = setInterval(() => this._runSafely(), this._runIntervalMs);
    if (this._intervalHandle.unref) this._intervalHandle.unref();
  }

  /**
   * Stops the scheduled repricing daemon.
   * @returns {void}
   */
  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
      utils.logAudit('INFO', 'Repricer: stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // Core cycle
  // ---------------------------------------------------------------------------

  /** Wraps runRepricingCycle so errors never crash the daemon. */
  async _runSafely() {
    try {
      const summary = await this.runRepricingCycle();
      utils.logAudit('INFO', `Repricer: cycle complete — evaluated=${summary.itemsEvaluated} repriced=${summary.itemsRepriced} errors=${summary.errors}`);
    } catch (err) {
      utils.logAudit('ERROR', `Repricer: unhandled error in repricing cycle: ${err.message}`);
    }
  }

  /**
   * Runs one full repricing cycle over all non-locked active listings.
   * @returns {Promise<{cycleStarted: string, itemsEvaluated: number, itemsRepriced: number, errors: number}>}
   */
  async runRepricingCycle() {
    const cycleStarted = new Date().toISOString();
    let itemsEvaluated = 0;
    let itemsRepriced = 0;
    let errors = 0;

    let listings;
    try {
      listings = utils.readJsonFileSecure(this._listingsPath, []);
    } catch (err) {
      utils.logAudit('ERROR', `Repricer: could not read listings file ${this._listingsPath}: ${err.message}`);
      return { cycleStarted, itemsEvaluated: 0, itemsRepriced: 0, errors: 1 };
    }

    const activeListing = listings.filter(l => l.status === 'ACTIVE' && !l.priceLocked && l.offerId);

    for (const listing of activeListing) {
      itemsEvaluated++;
      try {
        const repriced = await this._repriceListing(listing, listings);
        if (repriced) itemsRepriced++;
      } catch (err) {
        errors++;
        utils.logAudit('WARN', `Repricer: failed to reprice listing ${listing.sku || listing.id}: ${err.message}`);
      }
    }

    // Persist updated listings
    if (itemsRepriced > 0) {
      try {
        utils.writeJsonFileSecure(this._listingsPath, listings);
      } catch (err) {
        utils.logAudit('ERROR', `Repricer: failed to save updated listings: ${err.message}`);
      }
    }

    return { cycleStarted, itemsEvaluated, itemsRepriced, errors };
  }

  /**
   * Reprices a single listing. Mutates `listing.price` in-place if repriced.
   * @param {object} listing   - Listing object from the listings array.
   * @param {Array}  listings  - Full listings array (for in-place mutation).
   * @returns {Promise<boolean>} True if the price was changed and pushed to eBay.
   */
  async _repriceListing(listing, listings) {
    const title = listing.title || listing.name || '';
    if (!title) return false;

    // Fetch comps
    const comps = await this._ebayClient.searchEbayComps(title, listing.condition || 'USED_EXCELLENT');
    if (!comps || (!comps.prices && !comps.avgPrice)) return false;

    // Build prices array from comps
    const rawPrices = Array.isArray(comps.prices) ? comps.prices.map(Number).filter(p => p > 0)
      : comps.avgPrice ? [comps.avgPrice] : [];

    if (rawPrices.length === 0) return false;

    const iqrMedian = Repricer.computeIqrMedian(rawPrices);
    if (!iqrMedian || iqrMedian <= 0) return false;

    let newPrice = parseFloat((iqrMedian * this._priceMultiplier).toFixed(2));

    // Apply floor guard: COGS-based minimum margin
    const cogs = parseFloat(listing.cogs || listing.costOfGoods || 0);
    if (cogs > 0) {
      const minAllowed = parseFloat((cogs * (1 + this._minMarginPct)).toFixed(2));
      if (newPrice < minAllowed) {
        utils.logAudit('INFO', `Repricer: floor guard triggered for SKU=${listing.sku} — computed $${newPrice} < floor $${minAllowed}. Skipping.`);
        return false;
      }
    }

    // Apply ceiling guard if set
    const priceCap = parseFloat(listing.priceCap || listing.maxPrice || 0);
    if (priceCap > 0 && newPrice > priceCap) {
      newPrice = priceCap;
    }

    // Apply manual price floor if set
    const priceFloor = parseFloat(listing.priceFloor || 0);
    if (priceFloor > 0 && newPrice < priceFloor) {
      newPrice = priceFloor;
    }

    const oldPrice = parseFloat(listing.price || 0);

    // Only update if the change is meaningful (> $0.05)
    if (Math.abs(newPrice - oldPrice) <= 0.05) return false;

    // Push to eBay
    await this._pushPriceToEbay(listing.offerId, newPrice);

    // Record the change in the listing object (in-place)
    listing.price = newPrice;

    // Append to audit log
    this._appendToLog({
      timestamp: new Date().toISOString(),
      sku: listing.sku || listing.id,
      title: title.slice(0, 80),
      oldPrice,
      newPrice,
      compsMedian: iqrMedian,
      compsCount: rawPrices.length,
      reason: `IQR median $${iqrMedian} × multiplier ${this._priceMultiplier}`,
    });

    utils.logAudit('INFO', `Repricer: repriced SKU=${listing.sku} $${oldPrice} → $${newPrice} (IQR median=$${iqrMedian})`);
    return true;
  }

  /**
   * Pushes a new price to eBay via the Sell Inventory API.
   * @param {string} offerId   - eBay offer ID.
   * @param {number} newPrice  - New price in USD.
   * @returns {Promise<void>}
   */
  async _pushPriceToEbay(offerId, newPrice) {
    if (!offerId) throw new Error('offerId is required to push price to eBay');
    const offerData = await this._ebayClient.ebayRequest(`/offer/${encodeURIComponent(offerId)}`, 'GET');
    if (!offerData) throw new Error(`Could not fetch offer data for offerId=${offerId}`);
    offerData.pricingSummary = offerData.pricingSummary || {};
    offerData.pricingSummary.price = { value: String(newPrice), currency: 'USD' };
    // Also set top-level price for compatibility
    offerData.price = { value: String(newPrice), currency: 'USD' };
    await this._ebayClient.ebayRequest(`/offer/${encodeURIComponent(offerId)}`, 'PUT', offerData);
  }

  /**
   * Appends a reprice audit entry to the log file. Non-fatal.
   * @param {object} entry
   */
  _appendToLog(entry) {
    try {
      if (!fs.existsSync(this._scratchDir)) {
        fs.mkdirSync(this._scratchDir, { recursive: true });
      }
      const log = utils.readJsonFileSecure(this._logFile, []);
      log.push(entry);
      // Trim to last 10,000 entries
      const trimmed = log.length > 10000 ? log.slice(log.length - 10000) : log;
      utils.writeJsonFileSecure(this._logFile, trimmed);
    } catch (err) {
      utils.logAudit('WARN', `Repricer: failed to append to reprice log: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /**
   * Computes the IQR-filtered median of an array of prices.
   * Removes outliers outside [Q1 - 1.5×IQR, Q3 + 1.5×IQR] before computing median.
   * @param {number[]} prices - Raw price array.
   * @returns {number|null}   - Median of filtered prices, or null if input is empty.
   */
  static computeIqrMedian(prices) {
    if (!Array.isArray(prices) || prices.length === 0) return null;
    const sorted = [...prices].filter(p => typeof p === 'number' && !isNaN(p) && p > 0).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    if (sorted.length === 1) return sorted[0];
    if (sorted.length === 2) return parseFloat(((sorted[0] + sorted[1]) / 2).toFixed(2));

    const q1 = Repricer._percentile(sorted, 25);
    const q3 = Repricer._percentile(sorted, 75);
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;

    const filtered = sorted.filter(p => p >= lower && p <= upper);
    if (filtered.length === 0) return Repricer._median(sorted);
    return Repricer._median(filtered);
  }

  /**
   * Returns the value at a given percentile in a sorted array.
   * @param {number[]} sorted - Sorted ascending array.
   * @param {number} pct      - Percentile (0–100).
   * @returns {number}
   */
  static _percentile(sorted, pct) {
    const idx = (pct / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }

  /**
   * Returns the median of a sorted array.
   * @param {number[]} sorted
   * @returns {number}
   */
  static _median(sorted) {
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return parseFloat(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
    }
    return parseFloat(sorted[mid].toFixed(2));
  }
}

module.exports = { Repricer };
