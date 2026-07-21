/**
 * @file lib/inventorySync.js
 * @description Per-channel quantity reserve manager. Maintains a safety buffer
 *   and per-channel reserves so that multi-quantity listings never show more
 *   than the available balance, preventing API-lag double-sells.
 */

'use strict';

const path = require('path');
const utils = require('../utils');

// ---------------------------------------------------------------------------
// Core reserve math
// ---------------------------------------------------------------------------

/**
 * Computes the available quantity for each channel based on total stock,
 * per-channel reserves, and a global safety buffer.
 *
 * Formula: channelAvailable[ch] = max(0, totalQty - sold - buffer - sum(otherReserves))
 *
 * @param {object} inventoryItem - Listing/inventory item with quantity fields.
 * @param {number} inventoryItem.quantityTotal    - Total units on hand.
 * @param {number} inventoryItem.quantitySold     - Units sold so far.
 * @param {object} [inventoryItem.quantityReserves] - Per-channel max reserves: { ebay: N, shopify: N, ... }
 * @param {number} [inventoryItem.buffer=2]         - Safety buffer (never list last N units).
 * @returns {Object.<string, number>} Map of channel → available quantity.
 */
function computeChannelAvailable(inventoryItem) {
  if (!inventoryItem) throw new Error('inventorySync: inventoryItem is required');

  const total = Math.max(0, parseInt(inventoryItem.quantityTotal || 0, 10));
  const sold = Math.max(0, parseInt(inventoryItem.quantitySold || 0, 10));
  const buffer = Math.max(0, parseInt(inventoryItem.buffer != null ? inventoryItem.buffer : 2, 10));
  const reserves = inventoryItem.quantityReserves || {};

  const totalAvailable = Math.max(0, total - sold - buffer);
  const channels = Object.keys(reserves);

  const result = {};
  for (const channel of channels) {
    const channelReserve = Math.max(0, parseInt(reserves[channel] || 0, 10));
    // Available for this channel = min of its reserve and totalAvailable
    result[channel] = Math.min(channelReserve, totalAvailable);
  }

  return result;
}

/**
 * Processes a sale event: decrements quantitySold and returns updated available quantities.
 * @param {object} inventoryItem        - The listing/inventory item (will be mutated).
 * @param {number} [qtySold=1]          - Units sold in this transaction.
 * @returns {{ updated: object, channelAvailable: Object.<string, number> }}
 */
function processSaleEvent(inventoryItem, qtySold = 1) {
  if (!inventoryItem) throw new Error('inventorySync: inventoryItem is required');

  const qty = Math.max(1, parseInt(qtySold, 10));
  inventoryItem.quantitySold = Math.min(
    (inventoryItem.quantityTotal || 0),
    (inventoryItem.quantitySold || 0) + qty
  );

  const channelAvailable = computeChannelAvailable(inventoryItem);
  return { updated: inventoryItem, channelAvailable };
}

// ---------------------------------------------------------------------------
// Channel push helpers
// ---------------------------------------------------------------------------

/**
 * Builds a map of channel → quantity update payloads based on current inventory state.
 * Used to push updated quantities to all connected channels after a sale.
 * @param {object} inventoryItem - Listing with quantityReserves config.
 * @returns {Array<{channel: string, sku: string, newQty: number}>}
 */
function buildChannelUpdates(inventoryItem) {
  if (!inventoryItem) throw new Error('inventorySync: inventoryItem is required');

  const channelAvailable = computeChannelAvailable(inventoryItem);
  const sku = inventoryItem.sku || inventoryItem.id || '';

  return Object.entries(channelAvailable).map(([channel, qty]) => ({
    channel,
    sku,
    newQty: qty,
  }));
}

// ---------------------------------------------------------------------------
// Batch sync helper
// ---------------------------------------------------------------------------

/**
 * Applies a sale event to a listing in the listings array (in-place) and
 * returns the channel update payloads to push.
 *
 * @param {Array<object>} listings    - Full listings array (mutated in-place).
 * @param {string} itemId             - The listing ID/SKU that was sold.
 * @param {number} [qtySold=1]        - Quantity sold.
 * @returns {{ listing: object|null, updates: Array }}
 */
function applyAndComputeUpdates(listings, itemId, qtySold = 1) {
  if (!Array.isArray(listings)) throw new Error('inventorySync: listings must be an array');
  if (!itemId) throw new Error('inventorySync: itemId is required');

  const listing = listings.find(l => String(l.id || l.sku || '') === String(itemId));
  if (!listing) {
    utils.logAudit('WARN', `inventorySync: no listing found for itemId=${itemId}`);
    return { listing: null, updates: [] };
  }

  const { updated, channelAvailable } = processSaleEvent(listing, qtySold);
  const updates = buildChannelUpdates(updated);

  utils.logAudit('INFO', `inventorySync: sale applied — itemId=${itemId} qtySold=${qtySold} remaining=${updated.quantityTotal - updated.quantitySold}`, { channelAvailable });

  return { listing: updated, updates };
}

module.exports = {
  computeChannelAvailable,
  processSaleEvent,
  buildChannelUpdates,
  applyAndComputeUpdates,
};
