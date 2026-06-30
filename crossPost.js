/**
 * @file crossPost.js
 * @description Handles multi-channel cross-posting to Shopify, WooCommerce, and Etsy.
 * Includes a Dead-Letter Queue (DLQ) mechanism to log and retry failed cross-post sync jobs.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const utils = require('./utils');
const ebayClient = require('./ebayClient');

let shopifyLocationId = null;

const VALID_PLATFORMS = ['shopify', 'woocommerce', 'etsy'];
const MAX_DLQ_ATTEMPTS = 10;
const CIRCUIT_LIMIT = 5;
const DLQ_CHUNK_SIZE = 3;

function getRequiredBackoffMs(attempts) {
  const safeAttempts = Math.max(1, attempts || 1);
  return Math.min(Math.pow(2, safeAttempts - 1) * 2 * 60 * 1000, 24 * 60 * 60 * 1000);
}

function sanitizeListingForDlq(listing) {
  if (!listing || typeof listing !== 'object') {
    throw new Error('Invalid listing payload for DLQ');
  }
  const title = String(listing.title || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 200);
  const description = String(listing.description || '').slice(0, 50000);
  const suggestedPrice = parseFloat(listing.suggestedPrice);
  if (isNaN(suggestedPrice) || suggestedPrice <= 0) {
    throw new Error('Invalid suggestedPrice for DLQ entry');
  }
  return {
    title,
    description,
    suggestedPrice,
    brand: String(listing.brand || 'Generic').slice(0, 100),
    model: String(listing.model || 'Product').slice(0, 100),
    condition: String(listing.condition || 'NEW').slice(0, 50)
  };
}

function sanitizeImageUrlsForDlq(imageUrls) {
  if (!Array.isArray(imageUrls)) return [];
  return imageUrls
    .filter(url => typeof url === 'string' && /^https?:\/\//i.test(url.trim()))
    .map(url => url.trim())
    .slice(0, 24);
}

function assertValidPlatform(platform) {
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`Invalid platform: ${platform}`);
  }
}

function assertValidSku(sku) {
  if (!sku || typeof sku !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(sku)) {
    throw new Error('Invalid SKU format');
  }
}

function enrichDlqJob(job, now = Date.now()) {
  const attempts = job.attempts || 1;
  const jobAge = now - new Date(job.timestamp).getTime();
  const requiredBackoff = getRequiredBackoffMs(attempts);
  const retryInMs = Math.max(0, requiredBackoff - jobAge);
  let status = 'ready';
  if (job.exhausted || attempts >= MAX_DLQ_ATTEMPTS) {
    status = 'exhausted';
  } else if (jobAge < requiredBackoff) {
    status = 'backing_off';
  }
  return {
    ...job,
    status,
    retryInMs,
    retryAt: status === 'backing_off' ? new Date(now + retryInMs).toISOString() : null,
    maxAttempts: MAX_DLQ_ATTEMPTS
  };
}

async function getDlqEntries() {
  const dlq = await utils.readJsonFileSecureAsync(config.dlqPath, []);
  const now = Date.now();
  return dlq.map(job => enrichDlqJob(job, now));
}

async function getDlqSummary() {
  const entries = await getDlqEntries();
  return {
    total: entries.length,
    ready: entries.filter(e => e.status === 'ready').length,
    backingOff: entries.filter(e => e.status === 'backing_off').length,
    exhausted: entries.filter(e => e.status === 'exhausted').length,
    maxAttempts: MAX_DLQ_ATTEMPTS
  };
}

/**
 * Direct Shopify cross-post without automatic DLQ handling.
 */
async function crossPostToShopifyDirect(finalListing, imageUrls, sku) {
  const shopName = config.getSHOPIFY_SHOP_NAME();
  const accessToken = config.getSHOPIFY_ACCESS_TOKEN();

  if (!shopName || !accessToken) {
    throw new Error("Shopify credentials missing.");
  }

  const safeImages = sanitizeImageUrlsForDlq(imageUrls);

  const payload = {
    product: {
      title: finalListing.title,
      body_html: finalListing.description,
      vendor: finalListing.brand || "Generic",
      product_type: finalListing.model || "Product",
      status: "active",
      variants: [{
        price: String(finalListing.suggestedPrice),
        sku: sku,
        inventory_management: "shopify",
        inventory_policy: "deny"
      }],
      images: safeImages.map(url => ({ src: url }))
    }
  };

  const url = `https://${shopName}.myshopify.com/admin/api/2024-01/products.json`;
  const response = await ebayClient.fetchWithRetry(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Shopify API error: ${JSON.stringify(data)}`);
  }

  const productId = data.product?.id;
  const variant = data.product?.variants?.[0];

  if (productId && variant && variant.inventory_item_id && variant.inventory_management === 'shopify') {
    try {
      let locationId = shopifyLocationId;
      if (!locationId) {
        const locUrl = `https://${shopName}.myshopify.com/admin/api/2024-01/locations.json`;
        const locRes = await ebayClient.fetchWithRetry(locUrl, {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Accept": "application/json"
          }
        });
        if (locRes.ok) {
          const locData = await locRes.json();
          const activeLocation = (locData.locations || []).find(l => l.active !== false);
          if (activeLocation) {
            shopifyLocationId = activeLocation.id;
            locationId = activeLocation.id;
          }
        }
      }

      if (locationId) {
        const setInventoryUrl = `https://${shopName}.myshopify.com/admin/api/2024-01/inventory_levels/set.json`;
        const setInventoryRes = await ebayClient.fetchWithRetry(setInventoryUrl, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({
            location_id: locationId,
            inventory_item_id: variant.inventory_item_id,
            available: 1
          })
        });
        if (!setInventoryRes.ok) {
          const setInvData = await setInventoryRes.json();
          utils.logAudit("WARN", `Failed to set Shopify inventory: ${JSON.stringify(setInvData)}`);
        } else {
          utils.logAudit("INFO", `Set Shopify product ${productId} inventory quantity to 1 at location ${locationId}`);
        }
      } else {
        utils.logAudit("WARN", "Could not retrieve active Shopify location ID to set inventory quantity.");
      }
    } catch (invErr) {
      utils.logAudit("WARN", `Shopify inventory leveling failed for product ${productId}: ${invErr.message}`);
    }
  }

  return productId;
}

/**
 * Direct WooCommerce cross-post without automatic DLQ handling.
 */
async function crossPostToWooCommerceDirect(finalListing, imageUrls, sku) {
  const wcUrlStr = config.getWOOCOMMERCE_URL();
  const wcKey = config.getWOOCOMMERCE_KEY();
  const wcSecret = config.getWOOCOMMERCE_SECRET();

  if (!wcUrlStr || !wcKey || !wcSecret) {
    throw new Error("WooCommerce configuration missing.");
  }

  const safeImages = sanitizeImageUrlsForDlq(imageUrls);

  const wcPayload = {
    name: finalListing.title,
    type: "simple",
    regular_price: String(finalListing.suggestedPrice),
    description: finalListing.description,
    short_description: "Multichannel listing from eBay Lister",
    manage_stock: true,
    stock_quantity: 1,
    sku: sku,
    images: safeImages.map(url => ({ src: url }))
  };

  const auth = Buffer.from(`${wcKey}:${wcSecret}`).toString('base64');
  const wcRes = await ebayClient.fetchWithRetry(`${wcUrlStr}/wp-json/wc/v3/products`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(wcPayload)
  });

  const wcData = await wcRes.json();
  if (!wcRes.ok) throw new Error(`WooCommerce error: ${JSON.stringify(wcData)}`);
  return wcData.id;
}

/**
 * Direct Etsy cross-post without automatic DLQ handling.
 */
async function crossPostToEtsyDirect(finalListing, sku) {
  const etsyShopId = config.getETSY_SHOP_ID();
  const etsyToken = config.getETSY_ACCESS_TOKEN();
  const etsyClientId = config.getETSY_CLIENT_ID();

  if (!etsyShopId || !etsyToken) {
    throw new Error("Etsy configuration missing.");
  }
  if (!etsyClientId) {
    throw new Error("Etsy API key missing. Set ETSY_CLIENT_ID in your .env file.");
  }

  const cleanTitle = (finalListing.title || "No Title").replace(/\s+/g, ' ').trim().slice(0, 140);

  const etsyPayload = {
    quantity: 1,
    title: cleanTitle,
    description: finalListing.description || "",
    price: finalListing.suggestedPrice,
    who_made: "i_did",
    when_made: "made_to_order",
    taxonomy_id: 1,
    is_personalizable: false
  };

  const etsyRes = await ebayClient.fetchWithRetry(`https://api.etsy.com/v3/application/shops/${etsyShopId}/listings`, {
    method: "POST",
    headers: {
      "x-api-key": etsyClientId,
      "Authorization": `Bearer ${etsyToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(etsyPayload)
  });

  const etsyData = await etsyRes.json();
  if (!etsyRes.ok) throw new Error(`Etsy error: ${JSON.stringify(etsyData)}`);
  return etsyData.listing_id;
}

async function executeDlqRetry(job) {
  if (job.platform === 'shopify') {
    return crossPostToShopifyDirect(job.listing, job.imageUrls, job.sku);
  }
  if (job.platform === 'woocommerce') {
    return crossPostToWooCommerceDirect(job.listing, job.imageUrls, job.sku);
  }
  if (job.platform === 'etsy') {
    return crossPostToEtsyDirect(job.listing, job.sku);
  }
  throw new Error(`Unsupported platform: ${job.platform}`);
}

async function markDlqRetrySuccess(job, successId) {
  const history = await utils.readJsonFileSecureAsync(config.historyPath, []);
  const item = history.find(i => i.sku === job.sku);
  if (!item) return;

  if (job.platform === 'shopify') item.shopifyId = String(successId);
  else if (job.platform === 'woocommerce') item.woocommerceId = String(successId);
  else if (job.platform === 'etsy') item.etsyId = String(successId);

  await utils.writeJsonFileSecureAsync(config.historyPath, history);
}

/**
 * Add a failed cross-post job to the DLQ.
 */
async function addToDlq(platform, sku, listing, imageUrls, error) {
  try {
    assertValidPlatform(platform);
    assertValidSku(sku);

    const sanitizedListing = sanitizeListingForDlq(listing);
    const sanitizedImages = sanitizeImageUrlsForDlq(imageUrls);
    const safeError = String(error || 'Unknown error').slice(0, 500);

    const dlq = await utils.readJsonFileSecureAsync(config.dlqPath, []);
    const existingIndex = dlq.findIndex(item => item.sku === sku && item.platform === platform);
    const previousAttempts = existingIndex !== -1 ? (dlq[existingIndex].attempts || 1) : 0;

    const entry = {
      id: existingIndex !== -1 && dlq[existingIndex].id
        ? dlq[existingIndex].id
        : `${platform}-${sku}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      platform,
      sku,
      listing: sanitizedListing,
      imageUrls: sanitizedImages,
      attempts: previousAttempts + 1,
      lastError: safeError,
      exhausted: previousAttempts + 1 >= MAX_DLQ_ATTEMPTS
    };

    if (existingIndex !== -1) {
      dlq[existingIndex] = entry;
    } else {
      dlq.push(entry);
    }

    await utils.writeJsonFileSecureAsync(config.dlqPath, dlq);
    utils.logAudit("INFO", `Logged failed cross-post to DLQ. Platform: ${platform}, SKU: ${sku}, Error: ${safeError}`);
    return entry;
  } catch (err) {
    utils.logAudit("ERROR", `Failed to add to DLQ: ${err.message}`);
    throw err;
  }
}

async function removeFromDlq(sku, platform) {
  assertValidSku(sku);
  assertValidPlatform(platform);

  const dlq = await utils.readJsonFileSecureAsync(config.dlqPath, []);
  const next = dlq.filter(item => !(item.sku === sku && item.platform === platform));
  if (next.length === dlq.length) return false;

  await utils.writeJsonFileSecureAsync(config.dlqPath, next);
  utils.logAudit("INFO", `Removed DLQ entry for SKU ${sku} on ${platform}`);
  return true;
}

async function clearDlq() {
  const dlq = await utils.readJsonFileSecureAsync(config.dlqPath, []);
  const count = dlq.length;
  await utils.writeJsonFileSecureAsync(config.dlqPath, []);
  utils.logAudit("INFO", `Cleared DLQ (${count} entries removed)`);
  return count;
}

async function retryDlqJob(sku, platform, options = {}) {
  assertValidSku(sku);
  assertValidPlatform(platform);

  const dlq = await utils.readJsonFileSecureAsync(config.dlqPath, []);
  const index = dlq.findIndex(item => item.sku === sku && item.platform === platform);
  if (index === -1) {
    throw new Error('DLQ job not found');
  }

  const job = dlq[index];
  const enriched = enrichDlqJob(job);

  if (enriched.status === 'exhausted' && !options.force) {
    throw new Error(`Maximum retry attempts (${MAX_DLQ_ATTEMPTS}) reached. Dismiss or force retry.`);
  }
  if (enriched.status === 'backing_off' && !options.force) {
    throw new Error(`Job is in backoff. Retry available in ${Math.ceil(enriched.retryInMs / 1000)}s or use force retry.`);
  }

  job.attempts = (job.attempts || 1) + 1;
  job.timestamp = new Date().toISOString();
  job.exhausted = false;

  try {
    const successId = await executeDlqRetry(job);
    dlq.splice(index, 1);
    await utils.writeJsonFileSecureAsync(config.dlqPath, dlq);
    await markDlqRetrySuccess(job, successId);
    utils.logAudit("INFO", `Manual DLQ retry succeeded for SKU ${sku} on ${platform}. ID: ${successId}`);
    return { success: true, id: successId, platform, sku };
  } catch (err) {
    job.lastError = err.message;
    job.exhausted = job.attempts >= MAX_DLQ_ATTEMPTS;
    dlq[index] = job;
    await utils.writeJsonFileSecureAsync(config.dlqPath, dlq);
    utils.logAudit("WARN", `Manual DLQ retry failed for SKU ${sku} on ${platform}: ${err.message}`);
    throw err;
  }
}

/**
 * Cross-posts listing to Shopify.
 */
async function crossPostToShopify(finalListing, imageUrls, sku) {
  try {
    return await crossPostToShopifyDirect(finalListing, imageUrls, sku);
  } catch (err) {
    utils.logAudit("ERROR", `Shopify Cross-posting failed: ${err.message}`);
    await addToDlq("shopify", sku, finalListing, imageUrls, err.message);
    return null;
  }
}

/**
 * Cross-posts listing to WooCommerce.
 */
async function crossPostToWooCommerce(finalListing, imageUrls, sku) {
  try {
    return await crossPostToWooCommerceDirect(finalListing, imageUrls, sku);
  } catch (err) {
    utils.logAudit("ERROR", `WooCommerce Cross-posting failed: ${err.message}`);
    await addToDlq("woocommerce", sku, finalListing, imageUrls, err.message);
    return null;
  }
}

/**
 * Cross-posts listing to Etsy.
 */
async function crossPostToEtsy(finalListing, sku) {
  try {
    return await crossPostToEtsyDirect(finalListing, sku);
  } catch (err) {
    utils.logAudit("ERROR", `Etsy Cross-posting failed: ${err.message}`);
    await addToDlq("etsy", sku, finalListing, [], err.message);
    return null;
  }
}

/**
 * Processes all jobs inside the Dead-Letter Queue (DLQ).
 */
async function processPendingSyncsDlq() {
  let dlq = await utils.readJsonFileSecureAsync(config.dlqPath, []);
  if (dlq.length === 0) {
    return { processed: 0, succeeded: 0, remaining: 0, exhausted: 0 };
  }

  utils.logAudit("INFO", `Starting DLQ retry processing for ${dlq.length} items...`);

  const now = Date.now();
  const activeJobs = [];
  const remaining = [];
  const circuitBreaker = { shopify: 0, woocommerce: 0, etsy: 0 };

  for (const job of dlq) {
    const enriched = enrichDlqJob(job, now);
    if (enriched.status === 'exhausted' || enriched.status === 'backing_off') {
      remaining.push(job);
      continue;
    }
    activeJobs.push(job);
  }

  if (activeJobs.length === 0) {
    return {
      processed: 0,
      succeeded: 0,
      remaining: remaining.length,
      exhausted: remaining.filter(j => j.exhausted || (j.attempts || 1) >= MAX_DLQ_ATTEMPTS).length
    };
  }

  utils.logAudit("INFO", `Found ${activeJobs.length} DLQ items ready for retry (passed backoff interval).`);

  let succeeded = 0;

  for (let i = 0; i < activeJobs.length; i += DLQ_CHUNK_SIZE) {
    const chunk = activeJobs.slice(i, i + DLQ_CHUNK_SIZE);

    await Promise.all(chunk.map(async (job) => {
      if (circuitBreaker[job.platform] >= CIRCUIT_LIMIT) {
        utils.logAudit("WARN", `Circuit breaker tripped for ${job.platform}. Skipping SKU ${job.sku}.`);
        remaining.push(job);
        return;
      }

      utils.logAudit("INFO", `Retrying cross-post for SKU ${job.sku} on ${job.platform} (Attempt #${job.attempts})...`);

      job.attempts = (job.attempts || 1) + 1;
      job.timestamp = new Date().toISOString();

      let successId = null;
      try {
        successId = await executeDlqRetry(job);
        if (circuitBreaker[job.platform] > 0) circuitBreaker[job.platform]--;
      } catch (err) {
        job.lastError = err.message;
        job.exhausted = job.attempts >= MAX_DLQ_ATTEMPTS;
        circuitBreaker[job.platform]++;
        utils.logAudit("WARN", `Retry failed for SKU ${job.sku} on ${job.platform}: ${err.message}`);
      }

      if (successId) {
        succeeded++;
        utils.logAudit("INFO", `Retry succeeded for SKU ${job.sku} on ${job.platform}. ID: ${successId}`);
        await markDlqRetrySuccess(job, successId);
      } else {
        remaining.push(job);
      }
    }));
  }

  await utils.writeJsonFileSecureAsync(config.dlqPath, remaining);
  const exhaustedCount = remaining.filter(j => j.exhausted || (j.attempts || 1) >= MAX_DLQ_ATTEMPTS).length;
  utils.logAudit("INFO", `DLQ retry processing finished. ${succeeded} succeeded, ${remaining.length} remaining (${exhaustedCount} exhausted).`);

  return {
    processed: activeJobs.length,
    succeeded,
    remaining: remaining.length,
    exhausted: exhaustedCount
  };
}

module.exports = {
  crossPostToShopify,
  crossPostToWooCommerce,
  crossPostToEtsy,
  crossPostToShopifyDirect,
  crossPostToWooCommerceDirect,
  crossPostToEtsyDirect,
  addToDlq,
  removeFromDlq,
  clearDlq,
  retryDlqJob,
  getDlqEntries,
  getDlqSummary,
  processPendingSyncsDlq,
  MAX_DLQ_ATTEMPTS,
  VALID_PLATFORMS
};

