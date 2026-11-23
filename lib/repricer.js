/**
 * @file lib/repricer.js
 * @description AI-powered competitive repricer with IQR-based outlier resistance,
 *   per-item floor/ceiling guards, COGS minimum-margin protection, and a transparent audit log.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const utils = require('../utils');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MIN_MARGIN_PCT = 0.15;

class Repricer {
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

  start() {
    if (this._intervalHandle) {
      utils.logAudit('WARN', 'Repricer: start() called while already running — ignored');
      return;
    }
    this._runSafely();
    this._intervalHandle = setInterval(() => this._runSafely(), this._runIntervalMs);
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
      await this.runRepricingCycle();
    } catch (err) {
      utils.logAudit('ERROR', `Repricer: unhandled error in repricing cycle: ${err.message}`);
    }
  }

  async runRepricingCycle() {
    const cycleStarted = new Date().toISOString();
    let itemsEvaluated = 0;
    let itemsRepriced = 0;
    let errors = 0;

    let listings;
    try {
      listings = utils.readJsonFileSecure(this._listingsPath, []);
    } catch (err) {
      return { cycleStarted, itemsEvaluated: 0, itemsRepriced: 0, errors: 1 };
    }

    const activeListings = listings.filter(l => l.status === 'ACTIVE' && !l.priceLocked && l.offerId);

    for (const listing of activeListings) {
      itemsEvaluated++;
      try {
        const repriced = await this._repriceListing(listing);
        if (repriced) itemsRepriced++;
      } catch (err) {
        errors++;
        utils.logAudit('WARN', `Repricer: failed to reprice listing ${listing.sku || listing.id}: ${err.message}`);
      }
    }

    if (itemsRepriced > 0) {
      try {
        utils.writeJsonFileSecure(this._listingsPath, listings);
      } catch (err) {}
    }

    return { cycleStarted, itemsEvaluated, itemsRepriced, errors };
  }

  async _repriceListing(listing) {
    const title = listing.title || listing.name || '';
    if (!title) return false;

    const comps = await this._ebayClient.searchEbayComps(title, listing.condition || 'USED_EXCELLENT');
    if (!comps || (!comps.prices && !comps.items && !comps.avgPrice)) return false;

    const rawPrices = Array.isArray(comps.prices)
      ? comps.prices.map(Number).filter(p => p > 0)
      : (Array.isArray(comps.items) && comps.items.length > 0
          ? comps.items.map(i => Number(i && i.price)).filter(p => p > 0)
          : (comps.avgPrice ? [Number(comps.avgPrice)] : []));

    if (rawPrices.length === 0) return false;

    const iqrMedian = Repricer.computeIqrMedian(rawPrices);
    if (!iqrMedian || iqrMedian <= 0) return false;

    let newPrice = parseFloat((iqrMedian * this._priceMultiplier).toFixed(2));

    const details = listing.listingDetails || {};
    const cogs = parseFloat(listing.cogs ?? listing.costOfGoods ?? details.costOfGoods ?? 0);
    if (cogs > 0) {
      const minAllowed = parseFloat((cogs * (1 + this._minMarginPct)).toFixed(2));
      if (newPrice < minAllowed) {
        return false;
      }
    }

    const priceCap = parseFloat(listing.priceCap || listing.maxPrice || 0);
    if (priceCap > 0 && newPrice > priceCap) {
      newPrice = priceCap;
    }

    const priceFloor = parseFloat(listing.priceFloor || 0);
    if (priceFloor > 0 && newPrice < priceFloor) {
      newPrice = priceFloor;
    }

    const oldPrice = parseFloat(listing.price || 0);
    if (Math.abs(newPrice - oldPrice) <= 0.05) return false;

    await this._pushPriceToEbay(listing.offerId, newPrice);
    listing.price = newPrice;

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

    return true;
  }

  async _pushPriceToEbay(offerId, newPrice) {
    if (!offerId) throw new Error('offerId is required to push price to eBay');
    const offerData = await this._ebayClient.ebayRequest(`/offer/${encodeURIComponent(offerId)}`, 'GET');
    if (!offerData) throw new Error(`Could not fetch offer data for offerId=${offerId}`);
    offerData.pricingSummary = offerData.pricingSummary || {};
    offerData.pricingSummary.price = { value: String(newPrice), currency: 'USD' };
    offerData.price = { value: String(newPrice), currency: 'USD' };
    await this._ebayClient.ebayRequest(`/offer/${encodeURIComponent(offerId)}`, 'PUT', offerData);
  }

  _appendToLog(entry) {
    try {
      if (!fs.existsSync(this._scratchDir)) {
        fs.mkdirSync(this._scratchDir, { recursive: true });
      }
      const log = utils.readJsonFileSecure(this._logFile, []);
      log.push(entry);
      const trimmed = log.length > 10000 ? log.slice(log.length - 10000) : log;
      utils.writeJsonFileSecure(this._logFile, trimmed);
    } catch (err) {}
  }

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

  static _percentile(sorted, pct) {
    const idx = (pct / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }

  static _median(sorted) {
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return parseFloat(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
    }
    return parseFloat(sorted[mid].toFixed(2));
  }
}

module.exports = { Repricer };
