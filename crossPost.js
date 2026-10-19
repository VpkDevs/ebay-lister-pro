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

/**
 * Direct Shopify cross-post without automatic DLQ handling.
 */
async function crossPostToShopifyDirect(finalListing, imageUrls, sku) {
  const shopName = config.getSHOPIFY_SHOP_NAME();
  const accessToken = config.getSHOPIFY_ACCESS_TOKEN();

  if (!shopName || !accessToken) {
    throw new Error("Shopify credentials missing.");
  }

  // [WAVE1-A] Strip private-only fields (internalNotes, costOfGoods) before building the payload.
  finalListing = utils.sanitizeListingForMarketplace(finalListing);
  // [WAVE1-A] Thread keywords -> Shopify tags; MSRP -> variant compare-at price.
  const wave1aKeywords = Array.isArray(finalListing.keywords) ? finalListing.keywords : [];
  const wave1aMsrp = finalListing.msrp ? Number(finalListing.msrp) : null;

  const variantPayload = {
    price: String(finalListing.suggestedPrice),
    sku: sku,
    inventory_management: "shopify",
    inventory_policy: "deny"
  };
  if (wave1aMsrp && wave1aMsrp > 0) {
    variantPayload.compare_at_price = String(wave1aMsrp);
  }

  const payload = {
    product: {
      title: finalListing.title,
      body_html: finalListing.description,
      vendor: finalListing.brand || "Generic",
      product_type: finalListing.model || "Product",
      status: "active",
      // [WAVE1-A] Seller-entered keywords become Shopify tags.
      tags: wave1aKeywords.join(', '),
      variants: [variantPayload],
      images: imageUrls.map(url => ({ src: url }))
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

  // [WAVE1-A] Strip private-only fields (internalNotes, costOfGoods) before building the payload.
  finalListing = utils.sanitizeListingForMarketplace(finalListing);
  // [WAVE1-A] Thread keywords -> WooCommerce tags; MSRP -> description footer line.
  const wave1aKeywords = Array.isArray(finalListing.keywords) ? finalListing.keywords : [];
  let wave1aDescription = finalListing.description || "";
  if (finalListing.msrp && !wave1aDescription.includes("Original MSRP")) {
    wave1aDescription += `\n<p><strong>Original MSRP:</strong> $${Number(finalListing.msrp).toFixed(2)}</p>`;
  }

  const wcPayload = {
    name: finalListing.title,
    type: "simple",
    regular_price: String(finalListing.suggestedPrice),
    description: wave1aDescription,
    short_description: "Multichannel listing from eBay Lister",
    manage_stock: true,
    stock_quantity: 1,
    sku: sku,
    // [WAVE1-A] Seller-entered keywords become WooCommerce tags.
    tags: wave1aKeywords.map(name => ({ name })),
    images: imageUrls.map(url => ({ src: url }))
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
  const etsyClientId = config.getEBAY_CLIENT_ID();

  if (!etsyShopId || !etsyToken) {
    throw new Error("Etsy configuration missing.");
  }

  // [WAVE1-A] Strip private-only fields (internalNotes, costOfGoods) before building the payload.
  finalListing = utils.sanitizeListingForMarketplace(finalListing);
  // [WAVE1-A] Thread keywords -> Etsy tags (max 13); MSRP -> description footer line.
  const wave1aKeywords = Array.isArray(finalListing.keywords) ? finalListing.keywords : [];
  let wave1aDescription = finalListing.description || "";
  if (finalListing.msrp && !wave1aDescription.includes("Original MSRP")) {
    wave1aDescription += `\nOriginal MSRP: $${Number(finalListing.msrp).toFixed(2)}`;
  }

  const cleanTitle = (finalListing.title || "No Title").replace(/\s+/g, ' ').trim().slice(0, 140);

  const etsyPayload = {
    quantity: 1,
    title: cleanTitle,
    description: wave1aDescription,
    price: finalListing.suggestedPrice,
    who_made: "i_did",
    when_made: "made_to_order",
    taxonomy_id: 1,
    is_personalizable: false,
    // [WAVE1-A] Seller-entered keywords become Etsy tags.
    tags: wave1aKeywords.slice(0, 13)
  };

  const etsyRes = await ebayClient.fetchWithRetry(`https://api.etsy.com/v3/application/shops/${etsyShopId}/listings`, {
    method: "POST",
    headers: {
      "x-api-key": etsyClientId || "mock-etsy-client-id",
      "Authorization": `Bearer ${etsyToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(etsyPayload)
  });

  const etsyData = await etsyRes.json();
  if (!etsyRes.ok) throw new Error(`Etsy error: ${JSON.stringify(etsyData)}`);
  return etsyData.listing_id;
}

/**
 * Add a failed cross-post job to the DLQ.
 */
function addToDlq(platform, sku, listing, imageUrls, error) {
  try {
    const dlq = utils.readJsonFileSecure(config.dlqPath, []);
    const existingIndex = dlq.findIndex(item => item.sku === sku && item.platform === platform);
    
    const entry = {
      timestamp: new Date().toISOString(),
      platform,
      sku,
      listing,
      imageUrls,
      attempts: existingIndex !== -1 ? dlq[existingIndex].attempts + 1 : 1,
      lastError: error
    };

    if (existingIndex !== -1) {
      dlq[existingIndex] = entry;
    } else {
      dlq.push(entry);
    }

    utils.writeJsonFileSecure(config.dlqPath, dlq);
    utils.logAudit("INFO", `Logged failed cross-post to DLQ. Platform: ${platform}, SKU: ${sku}, Error: ${error}`);
  } catch (err) {
    utils.logAudit("ERROR", `Failed to add to DLQ: ${err.message}`);
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
    addToDlq("shopify", sku, finalListing, imageUrls, err.message);
    utils.appendNotification("cross-post", `Shopify cross-post failed for SKU ${sku} (queued for retry): ${err.message}`); // [WAVE1-B]
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
    addToDlq("woocommerce", sku, finalListing, imageUrls, err.message);
    utils.appendNotification("cross-post", `WooCommerce cross-post failed for SKU ${sku} (queued for retry): ${err.message}`); // [WAVE1-B]
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
    addToDlq("etsy", sku, finalListing, [], err.message);
    utils.appendNotification("cross-post", `Etsy cross-post failed for SKU ${sku} (queued for retry): ${err.message}`); // [WAVE1-B]
    return null;
  }
}

/**
 * Processes all jobs inside the Dead-Letter Queue (DLQ).
 */
async function processPendingSyncsDlq() {
  let dlq = utils.readJsonFileSecure(config.dlqPath, []);
  if (dlq.length === 0) {
    return;
  }
  
  utils.logAudit("INFO", `Starting DLQ retry processing for ${dlq.length} items...`);

  const remaining = [];
  for (const job of dlq) {
    utils.logAudit("INFO", `Retrying cross-post for SKU ${job.sku} on ${job.platform} (Attempt #${job.attempts})...`);
    
    job.attempts++;
    job.timestamp = new Date().toISOString();

    let successId = null;
    try {
      if (job.platform === 'shopify') {
        successId = await crossPostToShopifyDirect(job.listing, job.imageUrls, job.sku);
      } else if (job.platform === 'woocommerce') {
        successId = await crossPostToWooCommerceDirect(job.listing, job.imageUrls, job.sku);
      } else if (job.platform === 'etsy') {
        successId = await crossPostToEtsyDirect(job.listing, job.sku);
      }
    } catch (err) {
      job.lastError = err.message;
      utils.logAudit("WARN", `Retry failed for SKU ${job.sku} on ${job.platform}: ${err.message}`);
      // [WAVE1-B] Surface repeated cross-post retry failures to the user.
      utils.appendNotification("cross-post-retry", `${job.platform} cross-post retry failed for SKU ${job.sku}: ${err.message}`);
    }

    if (successId) {
      utils.logAudit("INFO", `Retry succeeded for SKU ${job.sku} on ${job.platform}. ID: ${successId}`);
      
      const history = utils.readJsonFileSecure(config.historyPath, []);
      const item = history.find(i => i.sku === job.sku);
      if (item) {
        if (job.platform === 'shopify') item.shopifyId = String(successId);
        else if (job.platform === 'woocommerce') item.woocommerceId = String(successId);
        else if (job.platform === 'etsy') item.etsyId = String(successId);
        utils.writeJsonFileSecure(config.historyPath, history);
      }
    } else {
      remaining.push(job);
    }
  }

  utils.writeJsonFileSecure(config.dlqPath, remaining);
  utils.logAudit("INFO", `DLQ retry processing finished. ${dlq.length - remaining.length} succeeded, ${remaining.length} remaining.`);
}

module.exports = {
  crossPostToShopify,
  crossPostToWooCommerce,
  crossPostToEtsy,
  crossPostToShopifyDirect,
  crossPostToWooCommerceDirect,
  crossPostToEtsyDirect,
  addToDlq,
  processPendingSyncsDlq
};
