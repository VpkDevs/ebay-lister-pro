/**
 * @file lib/analyticsEngine.js
 * @description P&L and Portfolio Profit Analytics Engine for ListAI Pro.
 *
 * Computes gross revenue, platform fees (eBay FVF + managed-payments processing),
 * shipping deltas, COGS, tax, and net profit — aggregated by channel and calendar month.
 * Also computes live portfolio profit projections from listings-history.json.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const utils = require('../utils');

/**
 * eBay Final Value Fee rates keyed by seller-defined category slug.
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

const PAYMENT_PCT  = 0.029;
const PAYMENT_FLAT = 0.30;
const CACHE_TTL_MS = 60 * 60 * 1000;

function toYearMonth(dateValue) {
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return 'unknown';
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}`;
}

function toNum(value) {
  const n = parseFloat(value);
  return isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computeEbayFee(order) {
  if (order.platformFeeOverride != null && isFinite(toNum(order.platformFeeOverride))) {
    return toNum(order.platformFeeOverride);
  }
  const salePrice   = toNum(order.salePrice);
  const categoryKey = (order.category || 'default').toLowerCase();
  const fvfRate = Object.prototype.hasOwnProperty.call(EBAY_FVF_RATES, categoryKey)
    ? EBAY_FVF_RATES[categoryKey]
    : EBAY_FVF_RATES.default;
  const fvf        = fvfRate * salePrice;
  const processing = salePrice > 0 ? (PAYMENT_PCT * salePrice + PAYMENT_FLAT) : 0;
  return fvf + processing;
}

function derivePlatformFee(order) {
  const channel = (order.channel || '').toLowerCase();
  if (channel === 'ebay') {
    return computeEbayFee(order);
  }
  if (order.platformFeeOverride != null && isFinite(toNum(order.platformFeeOverride))) {
    return toNum(order.platformFeeOverride);
  }
  if (channel && utils.MARKETPLACE_FEES && utils.MARKETPLACE_FEES[channel]) {
    return utils.estimateMarketplaceFee(channel, toNum(order.salePrice));
  }
  return 0;
}

function accumulateChannel(map, channel, grossRevenue, netProfit) {
  const key = channel.toLowerCase() || 'unknown';
  if (!map[key]) {
    map[key] = { grossRevenue: 0, netProfit: 0, orderCount: 0 };
  }
  map[key].grossRevenue += grossRevenue;
  map[key].netProfit    += netProfit;
  map[key].orderCount   += 1;
}

function accumulateMonth(map, yearMonth, grossRevenue, netProfit) {
  if (!map[yearMonth]) {
    map[yearMonth] = { grossRevenue: 0, netProfit: 0 };
  }
  map[yearMonth].grossRevenue += grossRevenue;
  map[yearMonth].netProfit    += netProfit;
}

/**
 * Synchronously computes a full P&L breakdown for the supplied orders array.
 * @param {Array<object>} orders
 * @param {{ period?: { start: string|Date, end: string|Date } }} [options]
 */
function computePnL(orders, options) {
  if (options === undefined) options = {};
  if (orders && !Array.isArray(orders) && typeof orders === 'object') {
    const sale = toNum(orders.salePrice ?? orders.soldPrice ?? orders.price);
    const shippingCharged = toNum(orders.shippingCharged);
    const gross = sale + shippingCharged;
    const cogs = toNum(orders.cogs ?? orders.costOfGoods);
    const shipping = toNum(orders.shippingCost);
    const adFee = toNum(orders.adFee) || (orders.adFeeRate ? round2(gross * toNum(orders.adFeeRate)) : 0);
    const ebayFee = round2(gross * 0.1325 + (gross > 0 ? 0.30 : 0));
    const totalFees = round2(ebayFee + adFee);
    const netProfit = round2(gross - totalFees - shipping - cogs);
    const marginPct = gross > 0 ? round2((netProfit / gross) * 100) : 0;
    const roiPct = cogs > 0 ? round2((netProfit / cogs) * 100) : 0;
    return {
      grossRevenue: round2(gross),
      ebayFee,
      adFee,
      totalPlatformFees: totalFees,
      totalShippingCost: round2(shipping),
      totalCOGS: round2(cogs),
      netProfit,
      marginPct,
      netMarginPct: marginPct,
      roiPct
    };
  }
  if (!Array.isArray(orders)) {
    utils.logAudit('WARN', 'analyticsEngine.computePnL received non-array orders; defaulting to empty array.');
    orders = [];
  }

  let filtered = orders;
  if (options && options.period) {
    const start = options.period.start ? new Date(options.period.start).getTime() : -Infinity;
    const end   = options.period.end   ? new Date(options.period.end).getTime()   :  Infinity;
    filtered = orders.filter(function(o) {
      if (!o.soldAt) return true;
      const t = new Date(o.soldAt).getTime();
      return isFinite(t) && t >= start && t <= end;
    });
  }

  let grossRevenue      = 0;
  let totalPlatformFees = 0;
  let totalShippingCost = 0;
  let totalCOGS         = 0;
  let totalTax          = 0;

  const byChannel = {};
  const byMonth   = {};
  const itemMap   = new Map();

  for (let i = 0; i < filtered.length; i++) {
    const order    = filtered[i];
    const sale     = toNum(order.salePrice);
    const shipping = toNum(order.shippingCost);
    const cogs     = toNum(order.cogs);
    const tax      = toNum(order.taxCollected);
    const fee      = derivePlatformFee(order);
    const profit   = sale - fee - shipping - cogs;

    grossRevenue      += sale;
    totalPlatformFees += fee;
    totalShippingCost += shipping;
    totalCOGS         += cogs;
    totalTax          += tax;

    const channel   = (order.channel || 'unknown').toLowerCase();
    const yearMonth = order.soldAt ? toYearMonth(order.soldAt) : 'undated';

    accumulateChannel(byChannel, channel, sale, profit);
    accumulateMonth(byMonth, yearMonth, sale, profit);

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
 * Computes both Realized P&L (from sold orders + SOLD history items) and
 * Unrealized Active Portfolio Profit Projections from listings-history.json.
 * @param {Array<object>} history - Rows from listings-history.json.
 * @param {Array<object>} [soldOrders=[]] - Explicit rows from sold-orders.json.
 */
function computePortfolioAnalytics(history = [], soldOrders = []) {
  const safeHistory = Array.isArray(history) ? history : [];
  const safeOrders  = Array.isArray(soldOrders) ? [...soldOrders] : [];
  const existingOrderIds = new Set(safeOrders.map(o => String(o.orderId || o.itemId || o.sku || '')));

  // Fold SOLD items from listings-history.json into sold orders if not already present
  for (const item of safeHistory) {
    if (item && item.status === 'SOLD' && !existingOrderIds.has(String(item.sku))) {
      const details = item.listingDetails || {};
      const cogs = toNum(item.costOfGoods ?? details.costOfGoods ?? 0);
      const price = toNum(item.price ?? details.suggestedPrice ?? 0);
      safeOrders.push({
        orderId: item.sku,
        itemId: item.sku,
        sku: item.sku,
        channel: item.shopifyId ? 'shopify' : (item.etsyId ? 'etsy' : (item.woocommerceId ? 'woocommerce' : 'ebay')),
        title: item.title || details.title || item.sku,
        salePrice: price,
        cogs,
        shippingCost: 0,
        soldAt: item.timestamp || new Date().toISOString()
      });
    }
  }

  const realized = computePnL(safeOrders);

  // Compute active + draft portfolio projections
  let activeCount = 0;
  let draftCount = 0;
  let activeGrossValue = 0;
  let activeTotalCogs = 0;
  let activeEstimatedFees = 0;
  let activeProjectedProfit = 0;

  for (const item of safeHistory) {
    if (!item) continue;
    const status = item.status || 'ACTIVE';
    const details = item.listingDetails || {};
    const price = toNum(item.price ?? details.suggestedPrice ?? 0);
    const cogs = toNum(item.costOfGoods ?? details.costOfGoods ?? 0);
    const qty = Math.max(1, parseInt(item.quantity ?? details.quantity ?? 1, 10) || 1);

    if (status === 'DRAFT') {
      draftCount++;
    } else if (status === 'ACTIVE') {
      activeCount++;
      const lineGross = price * qty;
      const lineCogs  = cogs * qty;
      const unitFee   = utils.estimateMarketplaceFee ? utils.estimateMarketplaceFee('ebay', price) : round2(price * 0.1325 + 0.30);
      const lineFee   = unitFee * qty;
      const lineProfit = lineGross - lineFee - lineCogs;

      activeGrossValue      += lineGross;
      activeTotalCogs       += lineCogs;
      activeEstimatedFees   += lineFee;
      activeProjectedProfit += lineProfit;
    }
  }

  const projectedMarginPct = activeGrossValue > 0
    ? round2((activeProjectedProfit / activeGrossValue) * 100)
    : 0;
  const projectedRoiPct = activeTotalCogs > 0
    ? round2((activeProjectedProfit / activeTotalCogs) * 100)
    : null;

  const realizedRoiPct = realized.totalCOGS > 0
    ? round2((realized.netProfit / realized.totalCOGS) * 100)
    : 0;

  const activeInventory = {
    activeCount,
    draftCount,
    totalRetailValue: round2(activeGrossValue),
    totalCogsInvested: round2(activeTotalCogs),
    estimatedFees: round2(activeEstimatedFees),
    projectedNetProfit: round2(activeProjectedProfit),
    projectedMarginPct,
    projectedRoiPct
  };

  return {
    realized,
    soldCount: safeOrders.length,
    totalNetProfit: realized.netProfit,
    avgMarginPct: realized.netMarginPct,
    avgRoiPct: realizedRoiPct,
    activeInventory,
    portfolio: {
      activeCount,
      draftCount,
      soldCount: safeOrders.length,
      totalListings: safeHistory.length,
      activeGrossValue: round2(activeGrossValue),
      activeTotalCogs: round2(activeTotalCogs),
      activeEstimatedFees: round2(activeEstimatedFees),
      activeProjectedProfit: round2(activeProjectedProfit),
      projectedMarginPct,
      projectedRoiPct
    }
  };
}

/**
 * Reads sold orders from `scratchDir/sold-orders.json`, applies an optional date
 * filter, computes a full P&L report, and caches the result to
 * `scratchDir/analytics-cache.json` for up to 60 minutes.
 */
function buildPnLReport(startDate, endDate, scratchDir) {
  if (!scratchDir || typeof scratchDir !== 'string') {
    throw new Error('analyticsEngine.buildPnLReport: scratchDir must be a non-empty string.');
  }

  const cacheFile  = path.join(scratchDir, 'analytics-cache.json');
  const ordersFile = path.join(scratchDir, 'sold-orders.json');

  const startStr = startDate ? new Date(startDate).toISOString() : null;
  const endStr   = endDate   ? new Date(endDate).toISOString()   : null;

  try {
    if (fs.existsSync(cacheFile)) {
      const cached = utils.readJsonFileSecure(cacheFile, null);
      if (cached && cached.generatedAt) {
        const age        = Date.now() - new Date(cached.generatedAt).getTime();
        const startMatch = (cached.startDate || null) === startStr;
        const endMatch   = (cached.endDate   || null) === endStr;
        if (age < CACHE_TTL_MS && startMatch && endMatch) {
          return Object.assign({}, cached, { fromCache: true });
        }
      }
    }
  } catch (cacheReadErr) {
    utils.logAudit('WARN', 'analyticsEngine: cache read failed (' + cacheReadErr.message + '), regenerating.');
  }

  let orders;
  try {
    orders = utils.readJsonFileSecure(ordersFile, []);
    if (!Array.isArray(orders)) orders = [];
  } catch (readErr) {
    orders = [];
  }

  const periodOptions = (startStr || endStr)
    ? { period: { start: startStr, end: endStr } }
    : {};

  const result = computePnL(orders, periodOptions);

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
  } catch (writeErr) {
    utils.logAudit('WARN', 'analyticsEngine: cache write failed: ' + writeErr.message);
  }

  return cachePayload;
}

module.exports = {
  EBAY_FVF_RATES,
  computePnL,
  computePortfolioAnalytics,
  buildPnLReport
};
