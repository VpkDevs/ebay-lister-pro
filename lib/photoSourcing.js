/**
 * @file lib/photoSourcing.js
 * @description Autonomous multi-source product photo hunting, downloading, AI-grade sprucing,
 * and upload pipeline. Searches eBay Catalog, UPCItemDB, Open Food Facts, Bing Image Search
 * (optional), Google Custom Search Engine (optional), and DuckDuckGo as a zero-key fallback.
 * Deduplicates by content hash, processes each image through the full imagePipeline
 * (bg removal → color correction → white canvas → watermark), and uploads to a temp host.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const utils = require('../utils');
const imageDownloader = require('./imageDownloader');
const imagePipeline = require('./imagePipeline');
const { uploadImage } = require('./imageHelpers');

// Per-request MD5 deduplication set (keyed by content hash, not URL, to catch duplicate images
// from different sources).
const SESSION_HASH_SET = new Set();

/**
 * Clears the per-request deduplication set so sourcing runs are independent.
 */
function clearSessionCache() {
  SESSION_HASH_SET.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// SOURCE ADAPTERS
// Each adapter returns Promise<string[]> of raw image URLs. Failures are swallowed
// so a single dead source never blocks the whole run.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Source 1: eBay Product Catalog (via existing ebayClient helper).
 * Returns stock photos keyed by product title.
 */
async function sourceFromEbayCatalog(title) {
  try {
    // Lazy-require to avoid circular dependency issues at module load time
    const ebayClient = require('../ebayClient');
    const urls = await ebayClient.searchCatalogStockPhotos(title);
    utils.logAudit('INFO', `[PhotoSource/eBayCatalog] Found ${urls.length} photos for "${title}"`);
    return Array.isArray(urls) ? urls : [];
  } catch (err) {
    utils.logAudit('WARN', `[PhotoSource/eBayCatalog] Failed: ${err.message}`);
    return [];
  }
}

/**
 * Source 2: eBay UPC Catalog lookup (returns images embedded in product record).
 * Only runs when a valid UPC/EAN/GTIN is supplied.
 */
async function sourceFromEbayUpc(upc) {
  if (!upc || !/^\d{8,14}$/.test(String(upc).trim().replace(/[\s-]/g, ''))) return [];
  try {
    const ebayClient = require('../ebayClient');
    const upcData = await ebayClient.lookupUPCOnEbay(upc);
    const urls = upcData?.stockImageUrls || [];
    utils.logAudit('INFO', `[PhotoSource/eBayUPC] Found ${urls.length} photos for UPC ${upc}`);
    return urls;
  } catch (err) {
    utils.logAudit('WARN', `[PhotoSource/eBayUPC] Failed: ${err.message}`);
    return [];
  }
}

/**
 * Source 3: UPCItemDB free API (https://www.upcitemdb.com/api/explorer#!/lookup/get_trial_lookup)
 * Returns product images keyed by GTIN. Free tier: 100 req/day, no key required.
 */
async function sourceFromUpcItemDb(upc) {
  if (!upc || !/^\d{8,14}$/.test(String(upc).trim().replace(/[\s-]/g, ''))) return [];
  const cleanUpc = String(upc).trim().replace(/[\s-]/g, '');
  try {
    const res = await axios.get(`https://api.upcitemdb.com/prod/trial/lookup`, {
      params: { upc: cleanUpc },
      timeout: 8000,
      headers: { 'Accept': 'application/json' }
    });
    const items = res.data?.items || [];
    const urls = [];
    for (const item of items) {
      if (Array.isArray(item.images)) {
        urls.push(...item.images.filter(u => typeof u === 'string' && u.startsWith('http')));
      }
    }
    utils.logAudit('INFO', `[PhotoSource/UPCItemDB] Found ${urls.length} photos for UPC ${cleanUpc}`);
    return urls;
  } catch (err) {
    utils.logAudit('WARN', `[PhotoSource/UPCItemDB] Failed: ${err.message}`);
    return [];
  }
}

/**
 * Source 4: Open Food Facts (free, no key, covers most food/grocery products by GTIN).
 */
async function sourceFromOpenFoodFacts(upc) {
  if (!upc || !/^\d{8,14}$/.test(String(upc).trim().replace(/[\s-]/g, ''))) return [];
  const cleanUpc = String(upc).trim().replace(/[\s-]/g, '');
  try {
    const res = await axios.get(`https://world.openfoodfacts.org/api/v2/product/${cleanUpc}`, {
      timeout: 8000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'eBayListerPro/2.0 (product photo sourcing)' }
    });
    if (res.data?.status !== 1) return [];
    const product = res.data.product || {};
    const urls = [];
    if (product.image_url) urls.push(product.image_url);
    if (product.image_front_url) urls.push(product.image_front_url);
    if (product.image_ingredients_url) urls.push(product.image_ingredients_url);
    if (product.image_nutrition_url) urls.push(product.image_nutrition_url);
    // selected_images contains the best available sizes
    const sel = product.selected_images || {};
    for (const imgGroup of Object.values(sel)) {
      const display = imgGroup?.display?.en || imgGroup?.display?.[''] || null;
      if (display && !urls.includes(display)) urls.push(display);
    }
    utils.logAudit('INFO', `[PhotoSource/OpenFoodFacts] Found ${urls.length} photos for UPC ${cleanUpc}`);
    return urls;
  } catch (err) {
    utils.logAudit('WARN', `[PhotoSource/OpenFoodFacts] Failed: ${err.message}`);
    return [];
  }
}

/**
 * Source 5: Bing Image Search API (optional – requires BING_SEARCH_API_KEY in .env).
 * Returns high-res product photo URLs ranked by Bing's relevance score.
 */
async function sourceFromBingImages(query, count = 10) {
  const apiKey = process.env.BING_SEARCH_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await axios.get('https://api.bing.microsoft.com/v7.0/images/search', {
      params: {
        q: query,
        count,
        imageType: 'Photo',
        size: 'Large',
        safeSearch: 'Moderate'
      },
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      timeout: 10000
    });
    const urls = (res.data?.value || []).map(img => img.contentUrl).filter(Boolean);
    utils.logAudit('INFO', `[PhotoSource/BingImages] Found ${urls.length} photos for "${query}"`);
    return urls;
  } catch (err) {
    utils.logAudit('WARN', `[PhotoSource/BingImages] Failed: ${err.message}`);
    return [];
  }
}

/**
 * Source 6: Google Custom Search Engine (optional – requires GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID).
 * Searches with image search type for high-quality product photos.
 */
async function sourceFromGoogleCSE(query, count = 10) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cx) return [];
  try {
    const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: apiKey,
        cx,
        q: query,
        searchType: 'image',
        num: Math.min(count, 10), // Google CSE max is 10 per request
        imgSize: 'large',
        imgType: 'photo',
        safe: 'medium'
      },
      timeout: 10000
    });
    const urls = (res.data?.items || []).map(item => item.link).filter(Boolean);
    utils.logAudit('INFO', `[PhotoSource/GoogleCSE] Found ${urls.length} photos for "${query}"`);
    return urls;
  } catch (err) {
    utils.logAudit('WARN', `[PhotoSource/GoogleCSE] Failed: ${err.message}`);
    return [];
  }
}

/**
 * Source 7: DuckDuckGo Instant Answer API (zero-key fallback).
 * Limited but reliable; returns the Instant Answer entity image + related topic thumbnails.
 */
async function sourceFromDuckDuckGo(query) {
  try {
    const res = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', ia: 'images', no_redirect: 1, no_html: 1 },
      timeout: 8000,
      headers: { 'User-Agent': 'eBayListerPro/2.0' }
    });
    const data = res.data || {};
    const urls = [];
    if (data.Image) urls.push(data.Image.startsWith('//') ? `https:${data.Image}` : data.Image);
    for (const topic of (data.RelatedTopics || [])) {
      if (topic.Icon?.URL) {
        const iconUrl = topic.Icon.URL.startsWith('//') ? `https:${topic.Icon.URL}` : topic.Icon.URL;
        if (!iconUrl.endsWith('favicon.ico')) urls.push(iconUrl);
      }
    }
    utils.logAudit('INFO', `[PhotoSource/DuckDuckGo] Found ${urls.length} candidate images for "${query}"`);
    return urls;
  } catch (err) {
    utils.logAudit('WARN', `[PhotoSource/DuckDuckGo] Failed: ${err.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// DEDUPLICATION & QUALITY FILTERING
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Deduplicates a raw photo filepath by hashing its content.
 * Returns true if it's a new unique photo, false if it's a duplicate.
 * @param {string} filepath - Local file path.
 * @returns {boolean}
 */
function isUniquePhoto(filepath) {
  try {
    const buffer = fs.readFileSync(filepath);
    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    if (SESSION_HASH_SET.has(hash)) return false;
    SESSION_HASH_SET.add(hash);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// DOWNLOAD + PROCESS + UPLOAD ONE PHOTO
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Downloads a single image URL, runs it through the full spruce pipeline,
 * uploads the result, and returns a structured result object.
 *
 * @param {string} url         - Raw candidate URL.
 * @param {string} source      - Label for the originating source (for audit log).
 * @param {object} spruceOpts  - imagePipeline options (bgRemove, bgStyle, colorCorrection, etc.)
 * @returns {Promise<object|null>} Photo result or null on failure.
 */
async function downloadProcessAndUpload(url, source, spruceOpts) {
  let localPath = null;
  let processedPath = null;
  try {
    // 1. Download with retry + MD5 cache
    localPath = await imageDownloader.downloadAndCacheImage(url);

    // 2. Content-level deduplication (skip near-identical images from different sources)
    if (!isUniquePhoto(localPath)) {
      utils.logAudit('INFO', `[PhotoSource] Duplicate content skipped: ${url}`);
      return null;
    }

    // 3. Run full spruce pipeline
    const result = await imagePipeline.processImageSource(localPath, spruceOpts);
    processedPath = result.outputPath;

    // 4. Upload to external temp host for EPS conversion later
    const uploadedUrl = await uploadImage(processedPath);
    const localUrl = `/uploads/processed/${path.basename(processedPath)}`;

    utils.logAudit('INFO', `[PhotoSource] ✓ Processed photo from ${source}: ${uploadedUrl}`);

    return {
      source,
      originalUrl: url,
      localUrl,
      uploadedUrl,
      metadata: result.metadata
    };
  } catch (err) {
    utils.logAudit('WARN', `[PhotoSource] Failed to process photo from ${source} (${url}): ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MASTER ORCHESTRATOR
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Autonomously sources, downloads, spruces, and uploads product photos.
 *
 * @param {object} params
 * @param {string} params.title          - Product title (used for keyword search).
 * @param {string} [params.brand]        - Brand name (appended to search query for precision).
 * @param {string} [params.model]        - Model number.
 * @param {string} [params.upc]          - UPC/EAN/GTIN barcode.
 * @param {number} [params.maxPhotos=8]  - Maximum number of final photos to deliver.
 * @param {object} [params.spruceOpts]   - imagePipeline processing options.
 *   @param {boolean} [params.spruceOpts.bgRemove=true]           - Remove background.
 *   @param {string}  [params.spruceOpts.bgStyle='white']         - Canvas background style.
 *   @param {boolean} [params.spruceOpts.colorCorrection=true]    - Auto color/contrast correction.
 *   @param {number}  [params.spruceOpts.canvasSize=1600]         - Output canvas size in pixels.
 *   @param {boolean} [params.spruceOpts.watermark]               - Apply watermark if configured.
 *
 * @returns {Promise<{photos: object[], sources: object, totalCandidates: number}>}
 */
async function sourceProductPhotos({
  title,
  brand,
  model,
  upc,
  maxPhotos = 8,
  spruceOpts = {}
}) {
  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new Error('Product title is required for photo sourcing.');
  }

  clearSessionCache();

  // Build a precise search query from available metadata
  const queryParts = [title];
  if (brand && brand !== 'Generic' && brand !== 'Unknown') queryParts.push(brand);
  if (model) queryParts.push(model);
  const searchQuery = queryParts.join(' ').trim();

  const defaultSpruceOpts = {
    bgRemove: true,
    bgStyle: 'white',
    colorCorrection: true,
    canvasSize: 1600,
    watermark: true,
    ...spruceOpts
  };

  utils.logAudit('INFO', `[PhotoSource] Starting autonomous photo sourcing for: "${searchQuery}" (UPC: ${upc || 'N/A'})`);

  // ── Stage 1: Fan out to all sources concurrently ──
  const [
    ebayCatalogUrls,
    ebayUpcUrls,
    upcItemDbUrls,
    openFoodFactsUrls,
    bingUrls,
    googleUrls,
    ddgUrls
  ] = await Promise.all([
    sourceFromEbayCatalog(title),
    sourceFromEbayUpc(upc),
    sourceFromUpcItemDb(upc),
    sourceFromOpenFoodFacts(upc),
    sourceFromBingImages(searchQuery),
    sourceFromGoogleCSE(searchQuery),
    sourceFromDuckDuckGo(searchQuery)
  ]);

  // ── Stage 2: Merge, prioritize and deduplicate URL list ──
  // Priority order: eBay UPC (most authoritative) → UPCItemDB → Open Food Facts →
  //                 eBay Catalog → Bing → Google CSE → DuckDuckGo
  const candidateUrlsOrdered = [
    ...ebayUpcUrls.map(u => ({ url: u, source: 'ebay_upc' })),
    ...upcItemDbUrls.map(u => ({ url: u, source: 'upcitemdb' })),
    ...openFoodFactsUrls.map(u => ({ url: u, source: 'open_food_facts' })),
    ...ebayCatalogUrls.map(u => ({ url: u, source: 'ebay_catalog' })),
    ...bingUrls.map(u => ({ url: u, source: 'bing_images' })),
    ...googleUrls.map(u => ({ url: u, source: 'google_cse' })),
    ...ddgUrls.map(u => ({ url: u, source: 'duckduckgo' }))
  ];

  const seenUrls = new Set();
  const dedupedCandidates = [];
  for (const candidate of candidateUrlsOrdered) {
    if (!candidate.url || typeof candidate.url !== 'string') continue;
    const normalized = candidate.url.split('?')[0]; // strip query params for URL-level dedup
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    dedupedCandidates.push(candidate);
  }

  const totalCandidates = dedupedCandidates.length;
  utils.logAudit('INFO', `[PhotoSource] ${totalCandidates} unique candidate URLs across all sources. Processing up to ${maxPhotos}...`);

  // ── Stage 3: Download, spruce, upload with concurrency limit ──
  // We process candidates in batches of 3 concurrent workers and stop once we have maxPhotos.
  const photos = [];
  const CONCURRENCY = 3;
  let candidateIndex = 0;

  const sourceSummary = {};

  async function worker() {
    while (candidateIndex < dedupedCandidates.length && photos.length < maxPhotos) {
      const idx = candidateIndex++;
      if (idx >= dedupedCandidates.length) return;
      const { url, source } = dedupedCandidates[idx];

      const result = await downloadProcessAndUpload(url, source, defaultSpruceOpts);
      if (result) {
        // Re-check limit after async wait (multiple workers race)
        if (photos.length < maxPhotos) {
          photos.push(result);
          sourceSummary[source] = (sourceSummary[source] || 0) + 1;
        }
      }
    }
  }

  const numWorkers = Math.min(CONCURRENCY, dedupedCandidates.length);
  await Promise.all(Array.from({ length: numWorkers }, () => worker()));

  utils.logAudit('INFO', `[PhotoSource] Done. Delivered ${photos.length} photos. Sources: ${JSON.stringify(sourceSummary)}`);

  return {
    photos,
    sources: sourceSummary,
    totalCandidates
  };
}

module.exports = {
  sourceProductPhotos,
  clearSessionCache,
  // Export individual source adapters for testing and reuse
  sourceFromEbayCatalog,
  sourceFromEbayUpc,
  sourceFromUpcItemDb,
  sourceFromOpenFoodFacts,
  sourceFromBingImages,
  sourceFromGoogleCSE,
  sourceFromDuckDuckGo
};
