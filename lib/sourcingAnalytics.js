/**
 * @file lib/sourcingAnalytics.js
 * @description Sourcing ROI Tracker — aggregates per-venue return-on-investment
 *   data from listings and sold orders. Identifies which sourcing venues (thrift
 *   stores, wholesale lots, etc.) yield the best margins and flags stale inventory.
 */

'use strict';

const path = require('path');
const utils = require('../utils');

/** Cache TTL: 60 minutes */
const CACHE_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Computes per-venue ROI metrics from listings and sold orders.
 * @param {Array<{id: string, title: string, sourcingVenue?: string, cogs?: number, createdAt?: string}>} listings
 * @param {Array<{itemId: string, salePrice: number, soldAt?: string}>} soldOrders
 * @returns {Array<{
 *   venue: string,
 *   totalItems: number,
 *   soldItems: number,
 *   sellThroughRate: number,
 *   avgROI: number|null,
 *   avgDaysToSell: number|null,
 *   totalProfit: number
 * }>}
 */
function computeVenueROI(listings, soldOrders) {
  if (!Array.isArray(listings)) throw new Error('listings must be an array');
  if (!Array.isArray(soldOrders)) throw new Error('soldOrders must be an array');

  // Build a sold-order map: itemId → {salePrice, soldAt}
  const soldMap = new Map();
  for (const order of soldOrders) {
    if (order.itemId) soldMap.set(String(order.itemId), order);
  }

  // Group listings by venue
  /** @type {Map<string, Array>} */
  const venueMap = new Map();
  for (const listing of listings) {
    const venue = (listing.sourcingVenue && String(listing.sourcingVenue).trim()) || 'Untagged';
    if (!venueMap.has(venue)) venueMap.set(venue, []);
    venueMap.get(venue).push(listing);
  }

  const results = [];

  for (const [venue, items] of venueMap) {
    let soldItems = 0;
    const roiValues = [];
    const daysToSellValues = [];
    let totalProfit = 0;

    for (const item of items) {
      const soldOrder = soldMap.get(String(item.id || ''));
      if (!soldOrder) continue;

      soldItems++;
      const salePrice = parseFloat(soldOrder.salePrice || 0);
      const cogs = parseFloat(item.cogs || 0);

      // ROI (only meaningful if we know COGS)
      if (cogs > 0) {
        const roi = (salePrice - cogs) / cogs;
        roiValues.push(roi);
        totalProfit += salePrice - cogs;
      } else {
        totalProfit += salePrice;
      }

      // Days to sell
      if (item.createdAt && soldOrder.soldAt) {
        const created = new Date(item.createdAt).getTime();
        const sold = new Date(soldOrder.soldAt).getTime();
        if (!isNaN(created) && !isNaN(sold) && sold > created) {
          daysToSellValues.push((sold - created) / 86400000);
        }
      }
    }

    const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    results.push({
      venue,
      totalItems: items.length,
      soldItems,
      sellThroughRate: items.length > 0 ? parseFloat((soldItems / items.length).toFixed(4)) : 0,
      avgROI: roiValues.length > 0 ? parseFloat(avg(roiValues).toFixed(4)) : null,
      avgDaysToSell: daysToSellValues.length > 0 ? parseFloat(avg(daysToSellValues).toFixed(1)) : null,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
    });
  }

  // Sort by total profit descending
  return results.sort((a, b) => b.totalProfit - a.totalProfit);
}

/**
 * Returns listings that are stale (older than `staleDays` and unsold).
 * @param {Array<{id: string, title: string, createdAt?: string}>} listings
 * @param {Array<{itemId: string}>} soldOrders
 * @param {number} [staleDays=60] - Days threshold for staleness.
 * @returns {Array<object & {daysStale: number}>}
 */
function getStaleInventoryAlerts(listings, soldOrders, staleDays = 60) {
  if (!Array.isArray(listings)) throw new Error('listings must be an array');
  if (!Array.isArray(soldOrders)) throw new Error('soldOrders must be an array');

  const soldIds = new Set(soldOrders.map(o => String(o.itemId || '')));
  const staleMs = staleDays * 86400000;
  const now = Date.now();

  const stale = [];
  for (const listing of listings) {
    if (soldIds.has(String(listing.id || ''))) continue; // Already sold
    if (!listing.createdAt) continue;

    const created = new Date(listing.createdAt).getTime();
    if (isNaN(created)) continue;

    const age = now - created;
    if (age > staleMs) {
      stale.push({ ...listing, daysStale: parseFloat((age / 86400000).toFixed(1)) });
    }
  }

  // Sort by most stale first
  return stale.sort((a, b) => b.daysStale - a.daysStale);
}

// ---------------------------------------------------------------------------
// Disk-backed report builder
// ---------------------------------------------------------------------------

/**
 * Reads listings and sold orders from disk, computes the full sourcing report,
 * and caches the result for 60 minutes.
 * @param {string} scratchDir - Path to the scratch directory.
 * @returns {{ venueROI: Array, staleAlerts: Array, generatedAt: string }}
 */
function buildSourcingReport(scratchDir) {
  if (!scratchDir || typeof scratchDir !== 'string') {
    throw new Error('buildSourcingReport: scratchDir is required');
  }

  const cacheFile = path.join(scratchDir, 'sourcing-cache.json');

  // Return cached result if still fresh
  try {
    const cached = utils.readJsonFileSecure(cacheFile, null);
    if (cached && cached.generatedAt) {
      const age = Date.now() - new Date(cached.generatedAt).getTime();
      if (age < CACHE_TTL_MS) return cached;
    }
  } catch (_) { /* cache miss — continue */ }

  // Read source data
  const listingsFile = path.join(scratchDir, 'listings.json');
  const ordersFile = path.join(scratchDir, 'sold-orders.json');
  const listings = utils.readJsonFileSecure(listingsFile, []);
  const soldOrders = utils.readJsonFileSecure(ordersFile, []);

  const venueROI = computeVenueROI(listings, soldOrders);
  const staleAlerts = getStaleInventoryAlerts(listings, soldOrders);
  const report = { venueROI, staleAlerts, generatedAt: new Date().toISOString() };

  // Cache result
  try {
    utils.writeJsonFileSecure(cacheFile, report);
  } catch (err) {
    utils.logAudit('WARN', `sourcingAnalytics: failed to write cache: ${err.message}`);
  }

  return report;
}

module.exports = { computeVenueROI, getStaleInventoryAlerts, buildSourcingReport };
