/**
 * @file lib/analyticsEngine.js
 * @description P&L Analytics Engine for eBay Multi-Channel Lister Pro.
 *
 * Computes gross revenue, platform fees (eBay FVF + managed-payments processing),
 * shipping deltas, COGS, tax, and net profit — aggregated by channel and calendar month.
 * Results are optionally cached to `scratchDir/analytics-cache.json` for 60 minutes.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const utils = require('../utils');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * eBay Final Value Fee rates keyed by seller-defined category slug.
 * Sources: eBay Fee Schedule (https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees).
 * Update these when eBay publishes new rate tables.
 *
 * @type {Object.<string, number>}
 */
const EBAY_FVF_RATES = {
  default:         0.1325,  // 13.25% — most categories
  motors_parts:    0.0965,  //  9.65%
  books_dvd:       0.1450,  // 14.50%
  clothing:        0.1500,  // 15.00% — clothing / shoes / accessories
  coins_stamps:    0.0650,  //  6.50%
  real_estate:     0.0100,  //  1.00%
  heavy_equipment: 0.0200   //  2.00%
};

/**
 * eBay Managed Payments processing fee components (Stripe-compatible flat rate).
 *  fee = PAYMENT_PCT * salePrice + PAYMENT_FLAT
 */
const PAYMENT_PCT  = 0.029;
const PAYMENT_FLAT = 0.30;

/** Cache time-to-live in milliseconds (60 minutes). */
const CACHE_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the ISO YYYY-MM string for a given date value.
 * @param {string|number|Date} dateValue
 * @returns {string}
 */
function toYearMonth(dateValue) {
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return 'unknown';
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}`;
}

/**
 * Coerces a value to a finite number, returning 0 if coercion fails.
 * @param {*} value
 * @returns {number}
 */
function toNum(value) {
  const n = parseFloat(value);
  return isFinite(n) ? n : 0;
}

/**
 * Computes the eBay platform fee for a single order.
 * Includes both the Final Value Fee and the Managed Payments processing fee.
 *
 * @param {{ salePrice: number, category?: string, platformFeeOverride?: number }} order
 * @returns {number} Total platform fee in dollars.
 */
function computeEbayFee(order) {
  if (order.platformFeeOverride != null && isFinite(toNum(order.platformFeeOverride))) {
    return toNum(order.platformFeeOverride);
  }
  const salePrice  = toNum(order.salePrice);
  const categoryKey = (order.category || 'default').toLowerCase();
  const fvfRate = Object.prototype.hasOwnProperty.call(EBAY_FVF_RATES, categoryKey)
    ? EBAY_FVF_RATES[categoryKey]
    : EBAY_FVF_RATES.default;
  const fvf        = fvfRate * salePrice;
  const processing = PAYMENT_PCT * salePrice + PAYMENT_FLAT;
  return fvf + processing;
}

/**
 * Derives the platform fee for a single order based on channel.
 *
 * @param {object} order
 * @returns {number}
 */
function derivePlatformFee(order) {
  const channel = (order.channel || '').toLowerCase();
  if (channel === 'ebay') {
    return computeEbayFee(order);
  }
  // Non-eBay channels: honour an explicit override, otherwise 0.
  if (order.platformFeeOverride != null && isFinite(toNum(order.platformFeeOverride))) {
    return toNum(order.platformFeeOverride);
  }
  return 0;
}

/**
 * Accumulates a per-channel bucket, initialising it on first access.
 *
 * @param {Object.<string, {grossRevenue: number, netProfit: number, orderCount: number}>} map
 * @param {string} channel
 * @param {number} grossRevenue
 * @param {number} netProfit
 */
function accumulateChannel(map, channel, grossRevenue, netProfit) {
  const key = channel.toLowerCase() || 'unknown';
  if (!map[key]) {
    map[key] = { grossRevenue: 0, netProfit: 0, orderCount: 0 };
  }
  map[key].grossRevenue += grossRevenue;
  map[key].netProfit    += netProfit;
  map[key].orderCount   += 1;
}

/**
 * Accumulates a per-month bucket.
 *
 * @param {Object.<string, {grossRevenue: number, netProfit: number}>} map
 * @param {string} yearMonth  e.g. '2026-06'
 * @param {number} grossRevenue
 * @param {number} netProfit
 */
function accumulateMonth(map, yearMonth, grossRevenue, netProfit) {
  if (!map[yearMonth]) {
    map[yearMonth] = { grossRevenue: 0, netProfit: 0 };
  }
  map[yearMonth].grossRevenue += grossRevenue;
  map[yearMonth].netProfit    += netProfit;
}

/**
 * Rounds a number to two decimal places (banker-safe for display).
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Order
 * @property {string}  orderId
 * @property {string}  channel               - 'ebay' | 'shopify' | 'woocommerce' | 'etsy' | ...
 * @property {number}  salePrice             - Total amount charged to the buyer (excluding tax).
 * @property {number}  shippingCharged       - Shipping amount paid by the buyer.
 * @property {number}  shippingCost          - Actual cost of postage paid by the seller.
 * @property {number}  cogs                  - Cost of goods sold.
 * @property {string}  [category]            - Key into EBAY_FVF_RATES (eBay only).
 * @property {number}  [platformFeeOverride] - Explicit override for platform fees.
 * @property {number}  [taxCollected]        - Sales tax collected (marketplace-facilitated).
 * @property {string}  [soldAt]              - ISO 8601 timestamp.
 * @property {string}  [title]               - Item title.
 * @property {string}  [buyerName]           - Buyer display name.
 * @property {string}  [trackingNumber]      - Shipment tracking number.
 */

/**
 * @typedef {object} PnLResult
 * @property {number}  grossRevenue
 * @property {number}  totalPlatformFees
 * @property {number}  totalShippingCost
 * @property {number}  totalCOGS
 * @property {number}  totalTax
 * @property {number}  netProfit
 * @property {number}  netMarginPct
 * @property {number}  orderCount
 * @property {Object.<string, {grossRevenue: number, netProfit: number, orderCount: number}>} byChannel
 * @property {Object.<string, {grossRevenue: number, netProfit: number}>} byMonth
 * @property {Array<{title: string, totalRevenue: number, totalProfit: number, units: number}>} topSellingItems
 */

/**
 * Synchronously computes a full P&L breakdown for the supplied orders array.
 *
 * platformFee logic:
 *  - eBay: FVF (category-based) + Managed Payments processing fee (2.9% + $0.30),
 *          unless `platformFeeOverride` is provided.
 *  - All other channels: `platformFeeOverride` if set, otherwise 0.
 *
 * @param {Order[]} orders - Array of normalised order objects.
 * @param {{ period?: { start: string|Date, end: string|Date } }} [options]
 * @returns {PnLResult}
 */
function computePnL(orders, options) {
  if (options === undefined) options = {};
  if (!Array.isArray(orders)) {
    utils.logAudit('WARN', 'analyticsEngine.computePnL received non-array orders; defaulting to empty array.');
    orders = [];
  }

  // Apply optional date filter
  let filtered = orders;
  if (options && options.period) {
    const start = options.period.start ? new Date(options.period.start).getTime() : -Infinity;
    const end   = options.period.end   ? new Date(options.period.end).getTime()   :  Infinity;
    filtered = orders.filter(function(o) {
      if (!o.soldAt) return true; // orders without a date pass the filter
      const t = new Date(o.soldAt).getTime();
      return isFinite(t) && t >= start && t <= end;
    });
  }

  // Accumulators
  let grossRevenue      = 0;
  let totalPlatformFees = 0;
  let totalShippingCost = 0;
  let totalCOGS         = 0;
  let totalTax          = 0;

  const byChannel = {};
  const byMonth   = {};

  /** @type {Map<string, {title: string, totalRevenue: number, totalProfit: number, units: number}>} */
  const itemMap = new Map();

  for (let i = 0; i < filtered.length; i++) {
    const order    = filtered[i];
    const sale     = toNum(order.salePrice);
    const shipping = toNum(order.shippingCost);
    const cogs     = toNum(order.cogs);
    const tax      = toNum(order.taxCollected);
    const fee      = derivePlatformFee(order);

    // Net profit = sale price - fees - actual shipping cost - COGS
    // Tax is marketplace-facilitated / pass-through; excluded from profit calculation.
    const profit = sale - fee - shipping - cogs;

    grossRevenue      += sale;
    totalPlatformFees += fee;
    totalShippingCost += shipping;
    totalCOGS         += cogs;
    totalTax          += tax;

    const channel   = (order.channel || 'unknown').toLowerCase();
    const yearMonth = order.soldAt ? toYearMonth(order.soldAt) : 'undated';

    accumulateChannel(byChannel, channel, sale, profit);
    accumulateMonth(byMonth, yearMonth, sale, profit);

    // Top-selling items keyed by title or orderId
    const titleKey = (order.title || order.orderId || 'Unknown Item').trim();
    if (!itemMap.has(titleKey)) {
      itemMap.set(titleKey, { title: titleKey, totalRevenue: 0, totalProfit: 0, units: 0 });
    }
    const entry = itemMap.get(titleKey);
    entry.totalRevenue += sale;
    entry.totalProfit  += profit;
    entry.units        += 1;
  }

  const netProfit    = grossRevenue - totalPlatformFees - totalShippingCost - totalCOGS;
  const netMarginPct = grossRevenue > 0
    ? round2((netProfit / grossRevenue) * 100)
    : 0;

  // Build top-10 by revenue
  const topSellingItems = Array.from(itemMap.values())
    .sort(function(a, b) { return b.totalRevenue - a.totalRevenue; })
    .slice(0, 10)
    .map(function(item) {
      return {
        title:        item.title,
        totalRevenue: round2(item.totalRevenue),
        totalProfit:  round2(item.totalProfit),
        units:        item.units
      };
    });

  // Round channel/month accumulators
  Object.keys(byChannel).forEach(function(k) {
    byChannel[k].grossRevenue = round2(byChannel[k].grossRevenue);
    byChannel[k].netProfit    = round2(byChannel[k].netProfit);
  });
  Object.keys(byMonth).forEach(function(k) {
    byMonth[k].grossRevenue = round2(byMonth[k].grossRevenue);
    byMonth[k].netProfit    = round2(byMonth[k].netProfit);
  });

  return {
    grossRevenue:      round2(grossRevenue),
    totalPlatformFees: round2(totalPlatformFees),
    totalShippingCost: round2(totalShippingCost),
    totalCOGS:         round2(totalCOGS),
    totalTax:          round2(totalTax),
    netProfit:         round2(netProfit),
    netMarginPct,
    orderCount:        filtered.length,
    byChannel,
    byMonth,
    topSellingItems
  };
}

/**
 * Reads sold orders from `scratchDir/sold-orders.json`, applies an optional date
 * filter, computes a full P&L report, and caches the result to
 * `scratchDir/analytics-cache.json` for up to 60 minutes.
 *
 * Cache hit criteria:
 *  - `generatedAt` is within 60 minutes of now.
 *  - Cached `startDate` and `endDate` strings match the requested values exactly
 *    (or both are absent).
 *
 * @param {string|Date|null} [startDate] - Inclusive lower bound (ISO string or Date).
 * @param {string|Date|null} [endDate]   - Inclusive upper bound (ISO string or Date).
 * @param {string}           scratchDir  - Absolute path to the scratch directory.
 * @returns {PnLResult & { generatedAt: string, fromCache: boolean }}
 */
function buildPnLReport(startDate, endDate, scratchDir) {
  if (!scratchDir || typeof scratchDir !== 'string') {
    throw new Error('analyticsEngine.buildPnLReport: scratchDir must be a non-empty string.');
  }

  const cacheFile  = path.join(scratchDir, 'analytics-cache.json');
  const ordersFile = path.join(scratchDir, 'sold-orders.json');

  const startStr = startDate ? new Date(startDate).toISOString() : null;
  const endStr   = endDate   ? new Date(endDate).toISOString()   : null;

  // ── Cache probe ──────────────────────────────────────────────────────────
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = utils.readJsonFileSecure(cacheFile, null);
      if (cached && cached.generatedAt) {
        const age        = Date.now() - new Date(cached.generatedAt).getTime();
        const startMatch = (cached.startDate || null) === startStr;
        const endMatch   = (cached.endDate   || null) === endStr;
        if (age < CACHE_TTL_MS && startMatch && endMatch) {
          utils.logAudit('INFO', 'analyticsEngine.buildPnLReport: serving result from cache.', {
            age: Math.round(age / 1000) + 's',
            startDate: startStr,
            endDate:   endStr
          });
          return Object.assign({}, cached, { fromCache: true });
        }
      }
    }
  } catch (cacheReadErr) {
    // Non-fatal — regenerate the report.
    utils.logAudit('WARN', 'analyticsEngine: cache read failed (' + cacheReadErr.message + '), regenerating.');
  }

  // ── Load orders ──────────────────────────────────────────────────────────
  let orders;
  try {
    orders = utils.readJsonFileSecure(ordersFile, []);
    if (!Array.isArray(orders)) {
      utils.logAudit('WARN', 'analyticsEngine: sold-orders.json did not contain an array; defaulting to [].');
      orders = [];
    }
  } catch (readErr) {
    utils.logAudit('ERROR', 'analyticsEngine.buildPnLReport: failed to read orders file: ' + readErr.message);
    orders = [];
  }

  // ── Compute P&L ──────────────────────────────────────────────────────────
  const periodOptions = (startStr || endStr)
    ? { period: { start: startStr, end: endStr } }
    : {};

  const result = computePnL(orders, periodOptions);

  // ── Persist cache ────────────────────────────────────────────────────────
  const cachePayload = Object.assign({}, result, {
    generatedAt: new Date().toISOString(),
    startDate:   startStr,
    endDate:     endStr,
    fromCache:   false
  });

  try {
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }
    utils.writeJsonFileSecure(cacheFile, cachePayload);
    utils.logAudit('INFO', 'analyticsEngine.buildPnLReport: cache written.', {
      orderCount: result.orderCount,
      netProfit:  result.netProfit
    });
  } catch (writeErr) {
    // Non-fatal — return computed result anyway.
    utils.logAudit('WARN', 'analyticsEngine: cache write failed: ' + writeErr.message);
  }

  return cachePayload;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  EBAY_FVF_RATES,
  computePnL,
  buildPnLReport
};
