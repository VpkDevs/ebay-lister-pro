/**
 * @file lib/accountingExport.js
 * @description QuickBooks-Ready & Schedule C Tax Accounting Exporter for ListAI Pro.
 *
 * Exports sold-order and inventory data to:
 *  - RFC-4180 CSV  (compatible with Excel, Google Sheets, QuickBooks Online, CPA Schedule C)
 *  - QuickBooks Desktop IIF  (direct double-entry import via File > Utilities > Import)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const utils = require('../utils');

function formatQBDate(value) {
  const d = value ? new Date(value) : new Date();
  if (isNaN(d.getTime())) return formatQBDate(null);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function formatYearMonth(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}`;
}

function toNum(value) {
  const n = parseFloat(value);
  return isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function csvField(value) {
  const str = (value == null) ? '' : String(value);
  return '"' + str.replace(/"/g, '""') + '"';
}

function csvRow(fields) {
  return fields.map(csvField).join(',') + '\r\n';
}

/**
 * Converts listings-history.json entries (SOLD, or all items when includeActive is true)
 * merged with any explicit soldOrders into the canonical ExportOrder array shape.
 * @param {Array<object>} history
 * @param {Array<object>} [soldOrders=[]]
 * @param {{ includeActive?: boolean }} [opts]
 * @returns {Array<object>}
 */
function normalizeHistoryToOrders(history = [], soldOrders = [], opts = {}) {
  const includeActive = !!opts.includeActive;
  const orders = Array.isArray(soldOrders) ? [...soldOrders] : [];
  const seenIds = new Set(orders.map(o => String(o.orderId || o.sku || '')));

  if (Array.isArray(history)) {
    for (const item of history) {
      if (!item) continue;
      const st = item.status || 'ACTIVE';
      if (st !== 'SOLD' && !(includeActive && st === 'ACTIVE')) continue;
      if (seenIds.has(String(item.sku))) continue;
      const details = item.listingDetails || {};
      const price = toNum(item.price ?? details.suggestedPrice ?? 0);
      const cogs  = toNum(item.costOfGoods ?? details.costOfGoods ?? 0);
      const channel = item.shopifyId ? 'shopify' : (item.etsyId ? 'etsy' : (item.woocommerceId ? 'woocommerce' : 'ebay'));
      const fee = utils.estimateMarketplaceFee ? utils.estimateMarketplaceFee(channel, price) : round2(price * 0.1325 + 0.30);
      orders.push({
        orderId: item.listingId || item.sku,
        sku: item.sku,
        channel,
        buyerName: st === 'SOLD' ? 'Marketplace Buyer' : 'Projected Sale (Active)',
        title: item.title || details.title || item.sku,
        salePrice: price,
        platformFee: fee,
        shippingCost: 0,
        cogs,
        taxCollected: 0,
        trackingNumber: '',
        soldAt: item.timestamp || new Date().toISOString()
      });
    }
  }
  return orders;
}

/**
 * Converts an array of orders to an RFC-4180 compliant CSV string.
 * Columns: Date, OrderID, Channel, BuyerName, ItemTitle, GrossRevenue, PlatformFee, ShippingCost, COGS, NetProfit, TaxCollected, TrackingNumber
 * @param {Array<object>} orders
 * @returns {string}
 */
function exportToCSV(orders) {
  if (!Array.isArray(orders)) {
    utils.logAudit('WARN', 'accountingExport.exportToCSV: received non-array; returning header-only CSV.');
    orders = [];
  }

  const rows = [];
  rows.push(csvRow([
    'Date', 'OrderID', 'Channel', 'BuyerName', 'ItemTitle',
    'GrossRevenue', 'PlatformFee', 'ShippingCost', 'COGS', 'NetProfit',
    'TaxCollected', 'TrackingNumber'
  ]));

  for (let i = 0; i < orders.length; i++) {
    const o           = orders[i];
    const sale        = toNum(o.salePrice || o.grossRevenue);
    const platformFee = toNum(o.platformFee || o.platformFeeOverride || 0);
    const shipping    = toNum(o.shippingCost);
    const cogs        = toNum(o.cogs);
    const tax         = toNum(o.taxCollected);
    const netProfit   = round2(sale - platformFee - shipping - cogs);

    rows.push(csvRow([
      o.soldAt ? new Date(o.soldAt).toISOString().slice(0, 10) : '',
      o.orderId        || '',
      o.channel        || '',
      o.buyerName      || '',
      o.title          || '',
      sale.toFixed(2),
      platformFee.toFixed(2),
      shipping.toFixed(2),
      cogs.toFixed(2),
      netProfit.toFixed(2),
      tax.toFixed(2),
      o.trackingNumber || ''
    ]));
  }

  utils.logAudit('INFO', 'accountingExport.exportToCSV: generated CSV.', { rowCount: orders.length });
  return rows.join('');
}

/**
 * Converts an array of orders to a QuickBooks Desktop IIF (Intuit Interchange Format) string.
 * @param {Array<object>} orders
 * @returns {string}
 */
function exportToIIF(orders) {
  if (!Array.isArray(orders)) {
    utils.logAudit('WARN', 'accountingExport.exportToIIF: received non-array; returning header-only IIF.');
    orders = [];
  }

  const TAB = '\t';
  const NL  = '\r\n';

  const header = [
    ['!TRNS', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'MEMO'].join(TAB),
    ['!SPL',  'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'MEMO'].join(TAB),
    '!ENDTRNS'
  ].join(NL) + NL;

  const lines = [header];

  for (let i = 0; i < orders.length; i++) {
    const o           = orders[i];
    const qbDate      = formatQBDate(o.soldAt);
    const buyerName   = (o.buyerName || 'Unknown Buyer').replace(/\t/g, ' ');
    const memo        = ((o.title || o.orderId || '') + ' via ' + (o.channel || 'unknown')).replace(/\t/g, ' ');

    const sale        = toNum(o.salePrice || o.grossRevenue);
    const platformFee = toNum(o.platformFee || o.platformFeeOverride || 0);
    const cogs        = toNum(o.cogs);

    const trns = [
      'TRNS', 'INVOICE', qbDate, 'Accounts Receivable', buyerName,
      sale.toFixed(2), memo
    ].join(TAB);

    const splRevenue = [
      'SPL', 'INVOICE', qbDate, 'Sales Revenue', buyerName,
      (-sale).toFixed(2), memo
    ].join(TAB);

    const splFeeLines = [];
    if (platformFee !== 0) {
      splFeeLines.push([
        'SPL', 'INVOICE', qbDate, 'Platform Fees', buyerName,
        platformFee.toFixed(2), 'Platform/marketplace fees'
      ].join(TAB));
    }

    const splCogsLines = [];
    if (cogs !== 0) {
      splCogsLines.push([
        'SPL', 'INVOICE', qbDate, 'Cost of Goods Sold', buyerName,
        cogs.toFixed(2), 'Cost of goods sold'
      ].join(TAB));
    }

    const block = [trns, splRevenue]
      .concat(splFeeLines)
      .concat(splCogsLines)
      .concat(['ENDTRNS'])
      .join(NL) + NL;

    lines.push(block);
  }

  utils.logAudit('INFO', 'accountingExport.exportToIIF: generated IIF.', { orderCount: orders.length });
  return lines.join('');
}

/**
 * Schedules a recurring monthly export of all orders found in `scratchDir/sold-orders.json`.
 */
function scheduleMonthlyExport(scratchDir, exportsDir) {
  if (!scratchDir || typeof scratchDir !== 'string') {
    throw new Error('accountingExport.scheduleMonthlyExport: scratchDir must be a non-empty string.');
  }
  if (!exportsDir || typeof exportsDir !== 'string') {
    throw new Error('accountingExport.scheduleMonthlyExport: exportsDir must be a non-empty string.');
  }

  const stateFile  = path.join(scratchDir, 'export-state.json');
  const ordersFile = path.join(scratchDir, 'sold-orders.json');

  function readState() {
    try {
      const state = utils.readJsonFileSecure(stateFile, { lastExportMonth: null });
      return (state && typeof state === 'object') ? state : { lastExportMonth: null };
    } catch (e) {
      return { lastExportMonth: null };
    }
  }

  function writeState(state) {
    try {
      utils.writeJsonFileSecure(stateFile, state);
    } catch (e) {
      utils.logAudit('WARN', 'accountingExport.scheduleMonthlyExport: could not persist export state: ' + e.message);
    }
  }

  function runExport(yearMonth) {
    try {
      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }
    } catch (mkdirErr) {
      return;
    }

    let orders = [];
    try {
      const raw = utils.readJsonFileSecure(ordersFile, []);
      orders = Array.isArray(raw) ? raw : [];
    } catch (readErr) {}

    try {
      const csvPath = path.join(exportsDir, 'orders-' + yearMonth + '.csv');
      fs.writeFileSync(csvPath, exportToCSV(orders), 'utf8');
    } catch (csvErr) {}

    try {
      const iifPath = path.join(exportsDir, 'orders-' + yearMonth + '.iif');
      fs.writeFileSync(iifPath, exportToIIF(orders), 'utf8');
    } catch (iifErr) {}

    writeState({ lastExportMonth: yearMonth });
  }

  function check() {
    try {
      const now = new Date();
      if (now.getDate() !== 1) return;
      const priorMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const yearMonth  = formatYearMonth(priorMonth);
      const state = readState();
      if (state.lastExportMonth === yearMonth) return;
      runExport(yearMonth);
    } catch (err) {}
  }

  check();
  const intervalId = setInterval(check, 60 * 60 * 1000);
  if (intervalId.unref && typeof intervalId.unref === 'function') {
    intervalId.unref();
  }

  return {
    stop: function() {
      clearInterval(intervalId);
    }
  };
}

module.exports = {
  exportToCSV,
  exportToIIF,
  normalizeHistoryToOrders,
  scheduleMonthlyExport
};
