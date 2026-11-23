/**
 * @file lib/inventorySync.js
 * @description Per-channel quantity reserve manager. Maintains a safety buffer
 *   and per-channel reserves so that multi-quantity listings never show more
 *   than the available balance, preventing API-lag double-sells.
 */

'use strict';

const utils = require('../utils');

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
    result[channel] = Math.min(channelReserve, totalAvailable);
  }

  return result;
}

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
