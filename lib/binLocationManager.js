/**
 * @file lib/binLocationManager.js
 * @description Physical bin location & barcode label system for warehouse picking.
 *   Generates Code 128B barcodes as pure SVG, print-ready bin labels, pick lists
 *   sorted by bin location, and bin inventory groupings — all with zero external deps.
 */

'use strict';

const CODE128B_PATTERNS = [
  '11011001100','11001101100','11001100110','10010011000','10010001100',
  '10001001100','10011001000','10011000100','10001100100','11001001000',
  '11001000100','11000100100','10110011100','10011011100','10011001110',
  '10111001100','10011101100','10011100110','11001110010','11001011100',
  '11001001110','11011100100','11001110100','11101101110','11101001100',
  '11100101100','11100100110','11101100100','11100110100','11100110010',
  '11011011000','11011000110','11000110110','10100011000','10001011000',
  '10001000110','10110001000','10001101000','10001100010','11010001000',
  '11000101000','11000100010','10110111000','10110001110','10001101110',
  '10111011000','10111000110','10001110110','11101110110','11010001110',
  '11000101110','11011101000','11011100010','11011101110','11101011000',
  '11101000110','11100010110','11101101000','11101100010','11100011010',
  '11101111010','11001000010','11110001010','10100110000','10100001100',
  '10010110000','10010000110','10000101100','10000100110','10110010000',
  '10110000100','10011010000','10011000010','10000110100','10000110010',
  '11000010010','11001010000','11110111010','11000010100','10001111010',
  '10100111100','10010111100','10010011110','10111100100','10011110100',
  '10011110010','11110100100','11110010100','11110010010','11011011110',
  '11011110110','11110110110','10101111000','10100011110','10001011110',
  '10111101000','10111100010','11110101000','11110100010','10111011110',
  '10111101110','11101011110','11110101110','11010000100','11010010000',
  '11010011100','1100011101011',
];

const START_B_IDX = 104;
const STOP_IDX = 106;

function encodeCode128B(text) {
  if (typeof text !== 'string') throw new Error('encodeCode128B: text must be a string');

  const modules = [];
  modules.push(CODE128B_PATTERNS[START_B_IDX]);
  let checksum = START_B_IDX;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code - 32;
    if (value < 0 || value > 95) {
      modules.push(CODE128B_PATTERNS[0]);
      checksum += 0;
    } else {
      modules.push(CODE128B_PATTERNS[value]);
      checksum += value * (i + 1);
    }
  }

  const checksumValue = checksum % 103;
  modules.push(CODE128B_PATTERNS[checksumValue]);
  modules.push(CODE128B_PATTERNS[STOP_IDX]);

  return '0'.repeat(10) + modules.join('') + '0'.repeat(10);
}

function generateBarcodeSVG(data, unitPx = 2, barH = 50) {
  const safeData = String(data || '').slice(0, 40);
  let modules;
  try {
    modules = encodeCode128B(safeData);
  } catch (_) {
    modules = encodeCode128B('ERROR');
  }

  const totalWidth = modules.length * unitPx;
  const svgHeight = barH + 16;

  let bars = '';
  let x = 0;
  for (const mod of modules) {
    if (mod === '1') {
      bars += `<rect x="${x}" y="0" width="${unitPx}" height="${barH}" fill="#000"/>`;
    }
    x += unitPx;
  }

  const labelText = safeData.length > 25 ? safeData.slice(0, 22) + '...' : safeData;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${svgHeight}" viewBox="0 0 ${totalWidth} ${svgHeight}">
  <rect width="${totalWidth}" height="${svgHeight}" fill="#fff"/>
  ${bars}
  <text x="${totalWidth / 2}" y="${barH + 12}" text-anchor="middle" font-family="monospace" font-size="10" fill="#333">${_escXml(labelText)}</text>
</svg>`;
}

function generateBinLabel(listing) {
  if (!listing) throw new Error('generateBinLabel: listing is required');

  const details = listing.listingDetails || {};
  const bin = (listing.binLocation || details.binLocation || 'UNASSIGNED').toUpperCase();
  const title = _truncate(listing.title || details.title || 'Untitled', 38);
  const channel = (listing.channel || 'EBAY').toUpperCase();
  const priceVal = listing.price ?? details.suggestedPrice;
  const price = priceVal != null ? `$${parseFloat(priceVal).toFixed(2)}` : '';
  const itemId = String(listing.id || listing.sku || 'NOID').slice(0, 20);

  const barcodeSvgRaw = generateBarcodeSVG(itemId, 1, 35);
  const barcodeInner = barcodeSvgRaw
    .replace(/<svg[^>]*>/, '')
    .replace('</svg>', '');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160" viewBox="0 0 400 160">
  <!-- Background -->
  <rect width="400" height="160" fill="#fff" stroke="#000" stroke-width="2"/>
  <!-- Bin location (large) -->
  <text x="12" y="42" font-family="Arial,sans-serif" font-size="30" font-weight="bold" fill="#111">${_escXml(bin)}</text>
  <!-- Separator line -->
  <line x1="10" y1="52" x2="390" y2="52" stroke="#ccc" stroke-width="1"/>
  <!-- Item title -->
  <text x="12" y="74" font-family="Arial,sans-serif" font-size="13" fill="#333">${_escXml(title)}</text>
  <!-- Channel + price -->
  <text x="12" y="96" font-family="Arial,sans-serif" font-size="12" fill="#666">${_escXml(channel)} ${_escXml(price)}</text>
  <!-- Item ID -->
  <text x="12" y="114" font-family="monospace" font-size="10" fill="#999">ID: ${_escXml(itemId)}</text>
  <!-- Barcode (right side) -->
  <g transform="translate(240, 55)">${barcodeInner}</g>
</svg>`;
}

function generatePickList(unfulfilledOrders, listings = []) {
  if (!Array.isArray(unfulfilledOrders)) throw new Error('unfulfilledOrders must be an array');
  if (!Array.isArray(listings)) listings = [];

  const listingMap = new Map(listings.map(l => [String(l.id || l.sku || ''), l]));

  const pickItems = unfulfilledOrders.map(order => {
    const listing = listingMap.get(String(order.itemId || order.sku || '')) || {};
    const details = listing.listingDetails || {};
    const bin = order.binLocation || listing.binLocation || details.binLocation || 'UNASSIGNED';
    const cleanTitle = _truncate(order.title || listing.title || details.title || order.itemTitle || 'Unknown Item', 60);
    const cleanQty = order.quantity || order.qty || 1;
    return {
      orderId: order.orderId || order.sku || '',
      sku: String(order.itemId || order.sku || listing.sku || ''),
      buyerName: order.buyerName || 'Unknown Buyer',
      title: cleanTitle,
      itemTitle: cleanTitle,
      binLocation: String(bin).trim() || 'UNASSIGNED',
      quantity: cleanQty,
      qty: cleanQty,
      channel: order.channel || 'ebay',
    };
  });

  return pickItems.sort((a, b) => a.binLocation.localeCompare(b.binLocation, undefined, { numeric: true, sensitivity: 'base' }));
}

function getBinInventory(listings) {
  if (!Array.isArray(listings)) throw new Error('listings must be an array');

  const groups = {};
  for (const listing of listings) {
    const details = (listing && listing.listingDetails) || {};
    const rawBin = listing.binLocation ?? details.binLocation;
    const bin = (rawBin && String(rawBin).trim()) || 'UNASSIGNED';
    if (!groups[bin]) groups[bin] = [];
    groups[bin].push(listing);
  }

  const sorted = {};
  for (const key of Object.keys(groups).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) {
    sorted[key] = groups[key];
  }
  return {
    totalBins: Object.keys(sorted).length,
    bins: sorted
  };
}

function _truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

function _escXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  generateBarcodeSVG,
  generateBinLabel,
  generatePickList,
  getBinInventory,
  encodeCode128B,
};
