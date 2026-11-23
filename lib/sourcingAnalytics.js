/**
 * @file lib/sourcingAnalytics.js
 * @description Sourcing ROI Tracker — aggregates per-venue return-on-investment
 *   data from listings and sold orders. Identifies which sourcing venues (thrift
 *   stores, wholesale lots, estate sales, etc.) yield the best margins and flags
 *   stale inventory tying up capital.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const utils = require('../utils');
const config = require('../config');

const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Normalizes a listing (from listings.json or listings-history.json) for sourcing math.
 */
function normalizeListingForSourcing(l) {
  if (!l || typeof l !== 'object') return {};
  const details = l.listingDetails || {};
  return {
    ...l,
    id: String(l.id || l.sku || ''),
    sku: String(l.sku || l.id || ''),
    title: l.title || details.title || '',
    sourcingVenue: l.sourcingVenue ?? details.sourcingVenue ?? '',
    cogs: l.cogs ?? l.costOfGoods ?? details.costOfGoods ?? 0,
    price: l.price ?? details.suggestedPrice ?? 0,
    createdAt: l.createdAt || l.timestamp || null,
    status: l.status || 'ACTIVE'
  };
}

function computeVenueROI(listings, soldOrders) {
  if (!Array.isArray(listings)) throw new Error('listings must be an array');
  if (!Array.isArray(soldOrders)) throw new Error('soldOrders must be an array');

  const normListings = listings.map(normalizeListingForSourcing);
  const soldMap = new Map();
  for (const order of soldOrders) {
    const key = String(order.itemId || order.sku || order.orderId || '');
    if (key) soldMap.set(key, order);
  }
  // Also recognize listings marked status === 'SOLD' in history
  for (const item of normListings) {
    if (item.status === 'SOLD' && item.id && !soldMap.has(item.id)) {
      soldMap.set(item.id, {
        itemId: item.id,
        salePrice: parseFloat(item.price || 0),
        soldAt: item.createdAt
      });
    }
  }

  const venueMap = new Map();
  for (const listing of normListings) {
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

      if (cogs > 0) {
        const roi = (salePrice - cogs) / cogs;
        roiValues.push(roi);
        totalProfit += salePrice - cogs;
      } else {
        totalProfit += salePrice;
      }

      if (item.createdAt && soldOrder.soldAt) {
        const created = new Date(item.createdAt).getTime();
        const sold = new Date(soldOrder.soldAt).getTime();
        if (!isNaN(created) && !isNaN(sold) && sold > created) {
          daysToSellValues.push((sold - created) / 86400000);
        }
      }
    }

    const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    const totalSpend = parseFloat(items.reduce((s, i) => s + (parseFloat(i.cogs) || 0), 0).toFixed(2));
    const sellThroughRate = items.length > 0 ? parseFloat((soldItems / items.length).toFixed(4)) : 0;
    const avgRoiRatio = roiValues.length > 0 ? parseFloat(avg(roiValues).toFixed(4)) : 0;

    results.push({
      venue,
      totalItems: items.length,
      totalSourced: items.length,
      soldItems,
      soldCount: soldItems,
      totalSpend,
      sellThroughRate,
      sellThroughPct: parseFloat((sellThroughRate * 100).toFixed(1)),
      avgROI: parseFloat((avgRoiRatio * 100).toFixed(1)),
      avgRoiRatio: roiValues.length > 0 ? avgRoiRatio : null,
      avgDaysToSell: daysToSellValues.length > 0 ? parseFloat(avg(daysToSellValues).toFixed(1)) : null,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
    });
  }

  return results.sort((a, b) => b.totalProfit - a.totalProfit);
}

function getStaleInventoryAlerts(listings, soldOrders, staleDays = 60) {
  if (!Array.isArray(listings)) throw new Error('listings must be an array');
  if (!Array.isArray(soldOrders)) throw new Error('soldOrders must be an array');

  const soldIds = new Set(soldOrders.map(o => String(o.itemId || o.sku || '')));
  const staleMs = staleDays * 86400000;
  const now = Date.now();

  const stale = [];
  for (const rawListing of listings) {
    const listing = normalizeListingForSourcing(rawListing);
    if (listing.status === 'SOLD' || listing.status === 'ENDED') continue;
    if (soldIds.has(String(listing.id || ''))) continue;
    if (!listing.createdAt) continue;

    const created = new Date(listing.createdAt).getTime();
    if (isNaN(created)) continue;

    const age = now - created;
    if (age > staleMs) {
      const daysStale = parseFloat((age / 86400000).toFixed(1));
      stale.push({
        ...rawListing,
        id: listing.id,
        sku: listing.sku,
        title: listing.title,
        price: listing.price,
        cogs: listing.cogs,
        sourcingVenue: listing.sourcingVenue || 'Untagged',
        venue: listing.sourcingVenue || 'Untagged',
        daysStale,
        daysListed: Math.round(daysStale)
      });
    }
  }

  return stale.sort((a, b) => b.daysStale - a.daysStale);
}

function buildSourcingReport(scratchDir, staleDays = 60) {
  if (!scratchDir || typeof scratchDir !== 'string') {
    throw new Error('buildSourcingReport: scratchDir is required');
  }

  const cacheFile = path.join(scratchDir, 'sourcing-cache.json');

  try {
    if (fs.existsSync(cacheFile)) {
      const cached = utils.readJsonFileSecure(cacheFile, null);
      if (cached && cached.generatedAt && (cached.staleDays || 60) === staleDays) {
        const age = Date.now() - new Date(cached.generatedAt).getTime();
        if (age < CACHE_TTL_MS) return cached;
      }
    }
  } catch (_) {}

  const listingsFile = path.join(scratchDir, 'listings.json');
  const ordersFile = path.join(scratchDir, 'sold-orders.json');
  let listings = fs.existsSync(listingsFile)
    ? utils.readJsonFileSecure(listingsFile, [])
    : utils.readJsonFileSecure(config.historyPath, []);
  const soldOrders = fs.existsSync(ordersFile)
    ? utils.readJsonFileSecure(ordersFile, [])
    : [];

  const venueROI = computeVenueROI(listings, soldOrders);
  const staleAlerts = getStaleInventoryAlerts(listings, soldOrders, staleDays);
  const report = { venueROI, staleAlerts, staleDays, generatedAt: new Date().toISOString() };

  try {
    utils.writeJsonFileSecure(cacheFile, report);
  } catch (err) {
    utils.logAudit('WARN', `sourcingAnalytics: failed to write cache: ${err.message}`);
  }

  return report;
}

module.exports = { computeVenueROI, getStaleInventoryAlerts, buildSourcingReport };
