/**
 * @file lib/accountingExport.js
 * @description QuickBooks-Ready Accounting Exporter for eBay Multi-Channel Lister Pro.
 *
 * Exports sold-order data to:
 *  - RFC-4180 CSV  (compatible with Excel, Google Sheets, QuickBooks Online import)
 *  - QuickBooks Desktop IIF  (direct import via File > Utilities > Import)
 *
 * Also provides `scheduleMonthlyExport` which runs an automatic midnight check on the
 * 1st of each month, writing both formats to `exportsDir`.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const utils = require('../utils');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Formats a Date (or ISO string) as MM/DD/YYYY — the format QuickBooks expects.
 * Falls back to today's date string if the input is invalid.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string}
 */
function formatQBDate(value) {
  const d = value ? new Date(value) : new Date();
  if (isNaN(d.getTime())) return formatQBDate(null);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Formats a Date (or ISO string) as YYYY-MM for file-naming purposes.
 *
 * @param {Date} d
 * @returns {string}
 */
function formatYearMonth(d) {
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}`;
}

/**
 * Coerces a value to a finite float, defaulting to 0.
 * @param {*} value
 * @returns {number}
 */
function toNum(value) {
  const n = parseFloat(value);
  return isFinite(n) ? n : 0;
}

/**
 * Rounds to two decimal places.
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Derives a best-effort net profit figure from an order object.
 * Mirrors the same logic used by analyticsEngine so exports are consistent.
 *
 * @param {object} order
 * @returns {number}
 */
function deriveNetProfit(order) {
  const sale     = toNum(order.salePrice || order.grossRevenue);
  const fee      = toNum(order.platformFee  || order.platformFeeOverride || 0);
  const shipping = toNum(order.shippingCost);
  const cogs     = toNum(order.cogs);
  return round2(sale - fee - shipping - cogs);
}

/**
 * Wraps a field value in double quotes per RFC-4180, escaping internal
 * double-quote characters by doubling them ("").
 *
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
function csvField(value) {
  const str = (value == null) ? '' : String(value);
  return '"' + str.replace(/"/g, '""') + '"';
}

/**
 * Builds a single RFC-4180 CSV row from an array of field values.
 *
 * @param {Array<string|number|null|undefined>} fields
 * @returns {string}  CRLF-terminated row.
 */
function csvRow(fields) {
  return fields.map(csvField).join(',') + '\r\n';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ExportOrder
 * @property {string}  [orderId]
 * @property {string}  [channel]
 * @property {string}  [buyerName]
 * @property {string}  [title]              - Item title.
 * @property {number}  [salePrice]          - Gross sale price (alias: grossRevenue).
 * @property {number}  [grossRevenue]       - Gross sale price (alias: salePrice).
 * @property {number}  [platformFee]        - Platform fee amount.
 * @property {number}  [platformFeeOverride]
 * @property {number}  [shippingCost]       - Seller's actual shipping cost.
 * @property {number}  [cogs]               - Cost of goods sold.
 * @property {number}  [taxCollected]       - Marketplace-collected sales tax.
 * @property {string}  [trackingNumber]
 * @property {string}  [soldAt]             - ISO 8601 timestamp.
 */

/**
 * Converts an array of orders to an RFC-4180 compliant CSV string.
 *
 * Columns (in order):
 *   Date, OrderID, Channel, BuyerName, ItemTitle,
 *   GrossRevenue, PlatformFee, ShippingCost, COGS, NetProfit,
 *   TaxCollected, TrackingNumber
 *
 * - All fields are wrapped in double-quotes.
 * - Internal double-quotes are escaped as "".
 * - Line endings are CRLF as required by RFC-4180.
 * - The first row is the header.
 *
 * @param {ExportOrder[]} orders
 * @returns {string} Complete CSV string.
 */
function exportToCSV(orders) {
  if (!Array.isArray(orders)) {
    utils.logAudit('WARN', 'accountingExport.exportToCSV: received non-array; returning header-only CSV.');
    orders = [];
  }

  const rows = [];

  // Header
  rows.push(csvRow([
    'Date', 'OrderID', 'Channel', 'BuyerName', 'ItemTitle',
    'GrossRevenue', 'PlatformFee', 'ShippingCost', 'COGS', 'NetProfit',
    'TaxCollected', 'TrackingNumber'
  ]));

  for (let i = 0; i < orders.length; i++) {
    const o          = orders[i];
    const sale       = toNum(o.salePrice || o.grossRevenue);
    const platformFee = toNum(o.platformFee || o.platformFeeOverride || 0);
    const shipping   = toNum(o.shippingCost);
    const cogs       = toNum(o.cogs);
    const tax        = toNum(o.taxCollected);
    const netProfit  = round2(sale - platformFee - shipping - cogs);

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
 *
 * Structure per order:
 *   TRNS  — top-level INVOICE entry (Accounts Receivable debit)
 *   SPL   — Sales Revenue credit   (negative amount = credit to income account)
 *   SPL   — Platform Fees debit    (positive amount = debit to expense account)
 *   SPL   — COGS debit             (positive amount = debit to COGS account)
 *   ENDTRNS
 *
 * Amount sign convention (QuickBooks IIF):
 *   Positive  = money in (debit to TRNS account / credit to SPL account)
 *   Negative  = money out / credit
 *
 * @param {ExportOrder[]} orders
 * @returns {string} IIF file content.
 */
function exportToIIF(orders) {
  if (!Array.isArray(orders)) {
    utils.logAudit('WARN', 'accountingExport.exportToIIF: received non-array; returning header-only IIF.');
    orders = [];
  }

  const TAB = '\t';
  const NL  = '\r\n';

  // IIF file-level headers (column definition rows)
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

    // TRNS: INVOICE — debit Accounts Receivable for full sale amount
    const trns = [
      'TRNS', 'INVOICE', qbDate, 'Accounts Receivable', buyerName,
      sale.toFixed(2), memo
    ].join(TAB);

    // SPL 1: Credit Sales Revenue (negative = credit in QB IIF convention)
    const splRevenue = [
      'SPL', 'INVOICE', qbDate, 'Sales Revenue', buyerName,
      (-sale).toFixed(2), memo
    ].join(TAB);

    // SPL 2: Debit Platform Fees expense (only if non-zero)
    const splFeeLines = [];
    if (platformFee !== 0) {
      splFeeLines.push([
        'SPL', 'INVOICE', qbDate, 'Platform Fees', buyerName,
        platformFee.toFixed(2), 'Platform/marketplace fees'
      ].join(TAB));
    }

    // SPL 3: Debit COGS (only if non-zero)
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
 * Schedules a recurring monthly export of all orders found in
 * `scratchDir/sold-orders.json`.
 *
 * Behaviour:
 *  - Runs an immediate check on startup.
 *  - Re-checks every hour via `setInterval`.  When `new Date().getDate() === 1`
 *    AND the last export was not already run this month, the export fires.
 *  - Writes `exportsDir/orders-{YYYY-MM}.csv` and `exportsDir/orders-{YYYY-MM}.iif`.
 *  - Persists the last-export timestamp to `scratchDir/export-state.json`.
 *  - Creates `exportsDir` (and any parents) if it does not exist.
 *
 * @param {string} scratchDir  - Absolute path to the scratch directory.
 * @param {string} exportsDir  - Absolute path to the exports output directory.
 * @returns {{ stop: function(): void }} Control handle — call `.stop()` to cancel the interval.
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

  /**
   * Reads the persisted export state.
   * @returns {{ lastExportMonth: string|null }}
   */
  function readState() {
    try {
      const state = utils.readJsonFileSecure(stateFile, { lastExportMonth: null });
      return (state && typeof state === 'object') ? state : { lastExportMonth: null };
    } catch (e) {
      return { lastExportMonth: null };
    }
  }

  /**
   * Persists the export state.
   * @param {{ lastExportMonth: string|null }} state
   */
  function writeState(state) {
    try {
      utils.writeJsonFileSecure(stateFile, state);
    } catch (e) {
      utils.logAudit('WARN', 'accountingExport.scheduleMonthlyExport: could not persist export state: ' + e.message);
    }
  }

  /**
   * Performs the export for the given YYYY-MM label.
   * @param {string} yearMonth
   */
  function runExport(yearMonth) {
    utils.logAudit('INFO', 'accountingExport.scheduleMonthlyExport: starting monthly export.', { yearMonth });

    // Ensure exportsDir exists
    try {
      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }
    } catch (mkdirErr) {
      utils.logAudit('ERROR', 'accountingExport.scheduleMonthlyExport: failed to create exportsDir: ' + mkdirErr.message);
      return;
    }

    // Load orders
    let orders = [];
    try {
      const raw = utils.readJsonFileSecure(ordersFile, []);
      orders = Array.isArray(raw) ? raw : [];
    } catch (readErr) {
      utils.logAudit('ERROR', 'accountingExport.scheduleMonthlyExport: failed to read orders: ' + readErr.message);
    }

    // Generate & write CSV
    try {
      const csvPath    = path.join(exportsDir, 'orders-' + yearMonth + '.csv');
      const csvContent = exportToCSV(orders);
      fs.writeFileSync(csvPath, csvContent, 'utf8');
      utils.logAudit('INFO', 'accountingExport.scheduleMonthlyExport: CSV written.', { path: csvPath, rows: orders.length });
    } catch (csvErr) {
      utils.logAudit('ERROR', 'accountingExport.scheduleMonthlyExport: CSV write failed: ' + csvErr.message);
    }

    // Generate & write IIF
    try {
      const iifPath    = path.join(exportsDir, 'orders-' + yearMonth + '.iif');
      const iifContent = exportToIIF(orders);
      fs.writeFileSync(iifPath, iifContent, 'utf8');
      utils.logAudit('INFO', 'accountingExport.scheduleMonthlyExport: IIF written.', { path: iifPath });
    } catch (iifErr) {
      utils.logAudit('ERROR', 'accountingExport.scheduleMonthlyExport: IIF write failed: ' + iifErr.message);
    }

    // Persist state
    writeState({ lastExportMonth: yearMonth });
  }

  /**
   * Checks whether an export should fire right now and runs it if so.
   */
  function check() {
    try {
      const now       = new Date();
      const dayOfMonth = now.getDate();
      if (dayOfMonth !== 1) return; // Only export on the 1st

      // Use prior month label for the export (we are exporting last month's data on the 1st)
      const priorMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const yearMonth  = formatYearMonth(priorMonth);

      const state = readState();
      if (state.lastExportMonth === yearMonth) {
        // Already exported this month cycle — skip.
        return;
      }

      runExport(yearMonth);
    } catch (err) {
      utils.logAudit('ERROR', 'accountingExport.scheduleMonthlyExport check error: ' + err.message);
    }
  }

  // Run immediately on startup
  check();

  // Then re-check every hour (3,600,000 ms)
  const intervalId = setInterval(check, 60 * 60 * 1000);

  // Ensure the interval does not prevent Node.js from exiting
  if (intervalId.unref && typeof intervalId.unref === 'function') {
    intervalId.unref();
  }

  utils.logAudit('INFO', 'accountingExport.scheduleMonthlyExport: scheduler registered.', {
    scratchDir,
    exportsDir,
    checkIntervalMs: 60 * 60 * 1000
  });

  return {
    /**
     * Cancels the monthly export schedule.
     * @returns {void}
     */
    stop: function() {
      clearInterval(intervalId);
      utils.logAudit('INFO', 'accountingExport.scheduleMonthlyExport: scheduler stopped.');
    }
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  exportToCSV,
  exportToIIF,
  scheduleMonthlyExport
};
