const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const utils = require('../utils');
const db = require('../lib/db');
const ebayClient = require('../ebayClient');
const geminiClient = require('../geminiClient');
const crossPost = require('../crossPost');
const { downloadAndOptimizeStockPhoto, convertImageToEPS } = require('../lib/imageHelpers');
const { validate, PublishSchema, SaveDraftSchema, DraftAutosaveSchema } = require('../lib/schemas');
const { ListerError } = require('../lib/errors');

const router = express.Router();

function createClientError(message, statusCode = 400) {
  return new ListerError(message, { status: statusCode, code: 'CLIENT_ERROR' });
}

function parseOptionalMoney(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createClientError(`${fieldName} must be a positive dollar amount.`);
  }
  return parsed;
}

function buildBestOfferTerms(payload, listingPrice) {
  if (!payload.bestOfferEnabled) return null;

  const autoAcceptPrice = parseOptionalMoney(payload.autoAcceptPrice, 'Auto-accept price');
  const autoDeclinePrice = parseOptionalMoney(payload.autoDeclinePrice, 'Auto-decline price');
  const price = Number(listingPrice);

  if (Number.isFinite(price) && price > 0) {
    if (autoAcceptPrice !== null && autoAcceptPrice > price) {
      throw createClientError('Auto-accept price cannot be greater than the Buy It Now price.');
    }
    if (autoDeclinePrice !== null && autoDeclinePrice >= price) {
      throw createClientError('Auto-decline price must be lower than the Buy It Now price.');
    }
  }

  if (autoAcceptPrice !== null && autoDeclinePrice !== null && autoDeclinePrice >= autoAcceptPrice) {
    throw createClientError('Auto-decline price must be lower than auto-accept price.');
  }

  const terms = { bestOfferEnabled: true };
  if (autoAcceptPrice !== null) {
    terms.autoAcceptPrice = {
      value: autoAcceptPrice.toFixed(2),
      currency: "USD"
    };
  }
  if (autoDeclinePrice !== null) {
    terms.autoDeclinePrice = {
      value: autoDeclinePrice.toFixed(2),
      currency: "USD"
    };
  }
  return terms;
}

function parsePromotionBidPercentage(payload) {
  if (!payload.promoteEnabled) return null;
  const parsed = payload.bidPercentage === undefined || payload.bidPercentage === null || payload.bidPercentage === ''
    ? 2.0
    : Number(payload.bidPercentage);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw createClientError('Ad campaign bid rate must be between 1 and 100 percent.');
  }
  return parsed;
}

function getCrossPostConfigIssue(platform) {
  if (platform === 'shopify') {
    return config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()
      ? null
      : 'Shopify is not configured. Save Shopify store name and Admin API token in the onboarding wizard.';
  }
  if (platform === 'woocommerce') {
    return config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()
      ? null
      : 'WooCommerce is not configured. Save store URL, consumer key, and consumer secret in the onboarding wizard.';
  }
  if (platform === 'etsy') {
    return config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN() && process.env.ETSY_CLIENT_ID
      ? null
      : 'Etsy is not configured. Save Etsy shop ID, access token, and API key in the onboarding wizard.';
  }
  return `Unsupported cross-post platform: ${platform}`;
}

async function queueCrossPostResult(platform, sku, listing, imageUrls, errorMessage) {
  try {
    await crossPost.addToDlq(platform, sku, listing, imageUrls || [], errorMessage);
    return { success: false, queued: true, error: errorMessage };
  } catch (err) {
    return { success: false, queued: false, error: `${errorMessage} DLQ save failed: ${err.message}` };
  }
}

async function runRequestedCrossPosts(payload, finalListing, finalImageUrls, sku) {
  const crossPostResults = {};
  const crossPostPromises = [];
  const crossPostKeys = [];

  const requests = [
    {
      platform: 'shopify',
      requested: !!payload.crossPostShopify,
      imageUrls: finalImageUrls,
      run: () => crossPost.crossPostToShopify(finalListing, finalImageUrls, sku)
    },
    {
      platform: 'woocommerce',
      requested: !!payload.crossPostWooCommerce,
      imageUrls: finalImageUrls,
      run: () => crossPost.crossPostToWooCommerce(finalListing, finalImageUrls, sku)
    },
    {
      platform: 'etsy',
      requested: !!payload.crossPostEtsy,
      imageUrls: [],
      run: () => crossPost.crossPostToEtsy(finalListing, sku)
    }
  ];

  for (const request of requests) {
    if (!request.requested) continue;
    const configIssue = getCrossPostConfigIssue(request.platform);
    if (configIssue) {
      crossPostResults[request.platform] = await queueCrossPostResult(
        request.platform,
        sku,
        finalListing,
        request.imageUrls,
        configIssue
      );
      continue;
    }
    crossPostPromises.push(request.run());
    crossPostKeys.push(request.platform);
  }

  let shopifyId = null;
  let woocommerceId = null;
  let etsyId = null;

  if (crossPostPromises.length > 0) {
    const results = await Promise.allSettled(crossPostPromises);
    results.forEach((resVal, idx) => {
      const platform = crossPostKeys[idx];
      if (resVal.status === 'fulfilled' && resVal.value) {
        crossPostResults[platform] = { success: true, queued: false, id: resVal.value };
        if (platform === 'shopify') shopifyId = String(resVal.value);
        else if (platform === 'woocommerce') woocommerceId = String(resVal.value);
        else if (platform === 'etsy') etsyId = String(resVal.value);
      } else if (resVal.status === 'fulfilled') {
        crossPostResults[platform] = {
          success: false,
          queued: true,
          error: `${platform} cross-post failed and was queued for retry.`
        };
      } else {
        const errMsg = resVal.reason?.message || "Unknown error";
        crossPostResults[platform] = { success: false, queued: false, error: errMsg };
        utils.logAudit("ERROR", `${platform} concurrent cross-posting failed: ${errMsg}`);
      }
    });
  }

  return { crossPostResults, shopifyId, woocommerceId, etsyId };
}

// API: Publish listing to eBay (and optional cross-posts)
router.post('/api/publish', validate(PublishSchema), async (req, res, next) => {
  try {
    const payload = req.body;
    const finalListing = payload.listing;
    const imageUrls = payload.imageUrls;

    geminiClient.validateAndFixListingSchema(finalListing);
    const listingPrice = parseOptionalMoney(finalListing.suggestedPrice, 'Listing price');
    if (listingPrice === null) {
      throw createClientError('Listing price is required.');
    }
    finalListing.suggestedPrice = Number(listingPrice.toFixed(2));
    const bestOfferTerms = buildBestOfferTerms(payload, listingPrice);
    const promotionBidPercentage = parsePromotionBidPercentage(payload);

    // 1. Deduplication Check
    if (payload.force !== true) {
      const history = db.listings.findAll();
      const isDuplicate = history.some(item => {
        if (item.status !== "ACTIVE" && item.status !== "DRAFT") return false;
        const ageMs = Date.now() - new Date(item.timestamp).getTime();
        if (ageMs > 60 * 60 * 1000) return false;
        const titleMatch = item.title && finalListing.title &&
          (item.title.toLowerCase().replace(/[^a-z0-9]/g, '') === finalListing.title.toLowerCase().replace(/[^a-z0-9]/g, ''));
        const upcMatch = item.listingDetails?.upc && finalListing.upc &&
          item.listingDetails.upc !== "Does Not Apply" && item.listingDetails.upc === finalListing.upc;
        return titleMatch || upcMatch;
      });

      if (isDuplicate) {
        return res.status(409).json({
          error: "DUPLICATE_LISTING",
          message: `A listing with a very similar title ("${finalListing.title}") was published or created in the last 60 minutes.`
        });
      }
    }

    // 2. VeRO Brand Check
    if (payload.force !== true && finalListing.brand) {
      const normalizedBrand = finalListing.brand.trim().toLowerCase();
      const veroBrands = config.getVERO_BRANDS();
      if (veroBrands.includes(normalizedBrand)) {
        return res.status(409).json({
          error: "VERO_BRAND_BLOCKED",
          message: `Brand "${finalListing.brand}" is registered under eBay's VeRO protection list. Publishing blocked to prevent policy violations.`
        });
      }
    }

    if (finalListing.description) {
      finalListing.description = utils.stripScriptsAndIframes(finalListing.description);
    }

    await ebayClient.refreshEbayAccessToken();

    const policies = await ebayClient.getOrCreateListingPolicies(
      payload.shippingOption || "USPS_GROUND",
      payload.returnOption || "NO_RETURNS",
      payload.immediatePayment !== false,
      payload.shippingType || "CALCULATED"
    );

    const shippingTerms = config.getSELLER_SHIPPING_TERMS();
    const returnTerms = config.getSELLER_RETURN_TERMS();
    const footer = `
      <hr style="margin-top: 30px; border: 0; border-top: 1px solid #ccc;" />
      <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; margin-top: 20px; line-height: 1.6;">
        <h3 style="color: #004680; margin-bottom: 5px;">Seller Terms & Information</h3>
        <p><strong>Shipping:</strong> ${shippingTerms}</p>
        <p><strong>Returns:</strong> ${returnTerms}</p>
      </div>
    `;

    if (!finalListing.description.includes("Seller Terms & Information")) {
      finalListing.description += footer;
    }

    const finalImageUrls = [];
    for (const url of imageUrls) {
      const epsUrl = await convertImageToEPS(url);
      finalImageUrls.push(epsUrl);
    }

    const sku = payload.sku || `${config.getSKU_PREFIX()}SKU-${Date.now()}`;
    const finalQty = parseInt(payload.quantity || finalListing.quantity || 1, 10) || 1;

    let inventoryItem = {
      condition: finalListing.condition,
      availability: { shipToLocationAvailability: { quantity: finalQty } },
      product: {
        title: finalListing.title,
        description: finalListing.description,
        brand: finalListing.brand,
        mpn: finalListing.model || "Does Not Apply",
        aspects: Object.fromEntries(Object.entries(finalListing.aspects).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])),
        imageUrls: finalImageUrls
      },
      packageWeightAndSize: {
        dimensions: {
          unit: "INCH",
          length: finalListing.packageLength,
          width: finalListing.packageWidth,
          height: finalListing.packageHeight
        },
        packageType: "PACKAGE",
        weight: {
          unit: "OUNCE",
          value: (finalListing.weightMajor * 16) + finalListing.weightMinor
        }
      }
    };

    inventoryItem = ebayClient.sanitizeAndOptimizeInventoryItem(inventoryItem);
    inventoryItem = ebayClient.genericizeVeroBrandListing(inventoryItem, payload.genericizeVero === true);
    await ebayClient.enrichRequiredAspects(inventoryItem, finalListing.categoryId);

    await ebayClient.ebayRequest(`/inventory_item/${encodeURIComponent(sku)}`, "PUT", inventoryItem);

    const offerPayload = {
      sku: sku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: finalQty,
      includeCatalogProductDetails: true,
      merchantLocationKey: config.getEBAY_LOCATION_KEY(),
      categoryId: finalListing.categoryId,
      listingDescription: finalListing.description,
      listingDuration: "GTC",
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentId,
        paymentPolicyId: policies.paymentId,
        returnPolicyId: policies.returnId
      },
      pricingSummary: {
        price: { currency: "USD", value: listingPrice.toFixed(2) }
      }
    };

    if (bestOfferTerms) {
      offerPayload.bestOfferTerms = bestOfferTerms;
    }

    const offerResponse = await ebayClient.ebayRequest("/offer", "POST", offerPayload);
    const publishResponse = await ebayClient.ebayRequest(`/offer/${offerResponse.offerId}/publish`, "POST");

    if (promotionBidPercentage !== null && publishResponse.listingId) {
      ebayClient.promoteListingStandard(publishResponse.listingId, sku, promotionBidPercentage);
    }

    const { crossPostResults, shopifyId, woocommerceId, etsyId } =
      await runRequestedCrossPosts(payload, finalListing, finalImageUrls, sku);

    utils.saveListingToHistory(
      sku,
      publishResponse.listingId,
      finalListing.title,
      finalListing.suggestedPrice,
      finalListing.categoryId,
      offerResponse.offerId,
      shopifyId,
      "ACTIVE",
      {
        ...finalListing,
        imageUrls: finalImageUrls
      },
      woocommerceId,
      etsyId
    );

    res.json({
      success: true,
      listingId: publishResponse.listingId,
      shopifyId,
      woocommerceId,
      etsyId,
      crossPostResults
    });
  } catch (e) {
    next(e);
  }
});

// API: Save draft listing
router.post('/api/save-draft', validate(SaveDraftSchema), async (req, res, next) => {
  try {
    const payload = req.body;
    const finalListing = payload.listing;
    const imageUrls = payload.imageUrls;

    geminiClient.validateAndFixListingSchema(finalListing);

    if (finalListing.description) {
      finalListing.description = utils.stripScriptsAndIframes(finalListing.description);
    }

    if (payload.force !== true) {
      const history = db.listings.findAll();
      const isDuplicate = history.some(item => {
        if (item.status !== "ACTIVE" && item.status !== "DRAFT") return false;
        if (payload.sku && item.sku === payload.sku) return false;
        const ageMs = Date.now() - new Date(item.timestamp).getTime();
        if (ageMs > 60 * 60 * 1000) return false;
        const titleMatch = item.title && finalListing.title &&
          (item.title.toLowerCase().replace(/[^a-z0-9]/g, '') === finalListing.title.toLowerCase().replace(/[^a-z0-9]/g, ''));
        const upcMatch = item.listingDetails?.upc && finalListing.upc &&
          item.listingDetails.upc !== "Does Not Apply" && item.listingDetails.upc === finalListing.upc;
        return titleMatch || upcMatch;
      });

      if (isDuplicate) {
        return res.status(409).json({
          error: "DUPLICATE_LISTING",
          message: `A listing with a very similar title ("${finalListing.title}") was published or created in the last 60 minutes.`
        });
      }
    }

    if (!finalListing.upc || finalListing.upc === "" || finalListing.upc === "Does Not Apply") {
      try {
        const compUpc = await ebayClient.findUpcFromComps(finalListing.title);
        if (compUpc) {
          finalListing.upc = compUpc;
        }
      } catch (e) {
        utils.logAudit("WARN", `Failed to auto-enrich UPC: ${e.message}`);
      }
    }

    let veroWarning = false;
    if (finalListing.brand) {
      const normalizedBrand = finalListing.brand.trim().toLowerCase();
      const veroBrands = config.getVERO_BRANDS();
      if (veroBrands.includes(normalizedBrand)) {
        veroWarning = true;
      }
    }
    finalListing.veroWarning = veroWarning;

    let sku = payload.sku;
    if (!sku) {
      const skuPrefix = config.getSKU_PREFIX();
      sku = `${skuPrefix}SKU-${Date.now()}`;
    }

    const skuClean = sku.replace(/[^a-zA-Z0-9-]/g, '_');
    const persistentDir = path.join(config.uploadTempDir, 'listings', skuClean);
    if (!fs.existsSync(persistentDir)) {
      fs.mkdirSync(persistentDir, { recursive: true });
    }

    const finalImageUrls = [];
    if (imageUrls && Array.isArray(imageUrls)) {
      for (const url of imageUrls) {
        if (url.startsWith('http') && !url.includes('tmpfiles.org') && !url.includes('file.io')) {
          const optUrl = await downloadAndOptimizeStockPhoto(url);
          finalImageUrls.push(optUrl);
        } else if (url.includes('/uploads/')) {
          const filename = path.basename(url);
          let sourcePath = path.join(config.uploadTempDir, 'processed', filename);
          if (!fs.existsSync(sourcePath)) {
            sourcePath = path.join(config.uploadTempDir, filename);
          }

          if (fs.existsSync(sourcePath)) {
            const targetPath = path.join(persistentDir, filename);
            fs.copyFileSync(sourcePath, targetPath);
            finalImageUrls.push(`/uploads/listings/${skuClean}/${filename}`);
          } else {
            finalImageUrls.push(url);
          }
        } else {
          finalImageUrls.push(url);
        }
      }
    }

    const listingDetails = {
      ...finalListing,
      imageUrls: finalImageUrls
    };

    const existing = db.listings.findBySku(sku);

    if (existing) {
      existing.timestamp = new Date().toISOString();
      existing.title = finalListing.title;
      existing.price = parseFloat(finalListing.suggestedPrice);
      existing.categoryId = finalListing.categoryId;
      existing.brand = finalListing.brand || "Generic";
      existing.veroWarning = veroWarning;
      existing.listingDetails = listingDetails;
      utils.persistListing(existing);
      utils.logAudit("INFO", `Updated existing draft. SKU: ${sku}`);
    } else {
      utils.saveListingToHistory(sku, null, finalListing.title, finalListing.suggestedPrice, finalListing.categoryId, null, null, "DRAFT", listingDetails);
    }

    res.json({ success: true, sku, veroWarning, upc: finalListing.upc });
  } catch (e) {
    next(e);
  }
});

// API: Publish draft listing
router.post('/api/publish-draft', async (req, res, next) => {
  try {
    const payload = req.body;
    if (typeof payload !== 'object' || payload === null || !payload.sku || typeof payload.sku !== 'string') {
      return res.status(400).json({ error: "Invalid payload: Missing SKU field" });
    }

    const item = db.listings.findBySku(payload.sku);
    if (!item) {
      return res.status(404).json({ error: "Draft not found with specified SKU" });
    }

    if (item.status !== "DRAFT" || !item.listingDetails) {
      return res.status(400).json({ error: "Item is not a valid draft listing" });
    }

    const finalListing = item.listingDetails;
    geminiClient.validateAndFixListingSchema(finalListing);
    const listingPrice = parseOptionalMoney(finalListing.suggestedPrice, 'Listing price');
    if (listingPrice === null) {
      throw createClientError('Listing price is required.');
    }
    finalListing.suggestedPrice = Number(listingPrice.toFixed(2));
    const bestOfferTerms = buildBestOfferTerms(payload, listingPrice);
    const promotionBidPercentage = parsePromotionBidPercentage(payload);

    // 1. Deduplication Check
    if (payload.force !== true) {
      const history = db.listings.findAll();
      const isDuplicate = history.some(histItem => {
        if (histItem.status !== "ACTIVE") return false;
        const ageMs = Date.now() - new Date(histItem.timestamp).getTime();
        if (ageMs > 60 * 60 * 1000) return false;
        const titleMatch = histItem.title && finalListing.title &&
          (histItem.title.toLowerCase().replace(/[^a-z0-9]/g, '') === finalListing.title.toLowerCase().replace(/[^a-z0-9]/g, ''));
        const upcMatch = histItem.listingDetails?.upc && finalListing.upc &&
          histItem.listingDetails.upc !== "Does Not Apply" && histItem.listingDetails.upc === finalListing.upc;
        return titleMatch || upcMatch;
      });

      if (isDuplicate) {
        return res.status(409).json({
          error: "DUPLICATE_LISTING",
          message: `A listing with a very similar title ("${finalListing.title}") was published in the last 60 minutes.`
        });
      }
    }

    // 2. VeRO Brand Check
    if (payload.force !== true && finalListing.brand) {
      const normalizedBrand = finalListing.brand.trim().toLowerCase();
      const veroBrands = config.getVERO_BRANDS();
      if (veroBrands.includes(normalizedBrand)) {
        return res.status(409).json({
          error: "VERO_BRAND_BLOCKED",
          message: `Brand "${finalListing.brand}" is registered under eBay's VeRO protection list. Publishing blocked.`
        });
      }
    }

    if (finalListing.description) {
      finalListing.description = utils.stripScriptsAndIframes(finalListing.description);
    }

    const imageUrls = finalListing.imageUrls || [];
    const finalImageUrls = [];
    for (const url of imageUrls) {
      const epsUrl = await convertImageToEPS(url);
      finalImageUrls.push(epsUrl);
    }
    finalListing.imageUrls = finalImageUrls;

    const shippingTerms = config.getSELLER_SHIPPING_TERMS();
    const returnTerms = config.getSELLER_RETURN_TERMS();
    const footer = `
      <hr style="margin-top: 30px; border: 0; border-top: 1px solid #ccc;" />
      <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; margin-top: 20px; line-height: 1.6;">
        <h3 style="color: #004680; margin-bottom: 5px;">Seller Terms & Information</h3>
        <p><strong>Shipping:</strong> ${shippingTerms}</p>
        <p><strong>Returns:</strong> ${returnTerms}</p>
      </div>
    `;

    if (!finalListing.description.includes("Seller Terms & Information")) {
      finalListing.description += footer;
    }

    await ebayClient.refreshEbayAccessToken();

    const policies = await ebayClient.getOrCreateListingPolicies(
      payload.shippingOption || "USPS_GROUND",
      payload.returnOption || "NO_RETURNS",
      payload.immediatePayment !== false,
      payload.shippingType || "CALCULATED"
    );

    const finalQty = parseInt(payload.quantity || finalListing.quantity || 1, 10) || 1;

    let inventoryItem = {
      condition: finalListing.condition,
      availability: { shipToLocationAvailability: { quantity: finalQty } },
      product: {
        title: finalListing.title,
        description: finalListing.description,
        brand: finalListing.brand,
        mpn: finalListing.model || "Does Not Apply",
        aspects: Object.fromEntries(Object.entries(finalListing.aspects || {}).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])),
        imageUrls: finalImageUrls
      },
      packageWeightAndSize: {
        dimensions: {
          unit: "INCH",
          length: finalListing.packageLength,
          width: finalListing.packageWidth,
          height: finalListing.packageHeight
        },
        packageType: "PACKAGE",
        weight: {
          unit: "OUNCE",
          value: (finalListing.weightMajor * 16) + finalListing.weightMinor
        }
      }
    };

    inventoryItem = ebayClient.sanitizeAndOptimizeInventoryItem(inventoryItem);
    inventoryItem = ebayClient.genericizeVeroBrandListing(inventoryItem, payload.genericizeVero === true);
    await ebayClient.enrichRequiredAspects(inventoryItem, finalListing.categoryId);

    await ebayClient.ebayRequest(`/inventory_item/${encodeURIComponent(payload.sku)}`, "PUT", inventoryItem);

    const offerPayload = {
      sku: payload.sku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: finalQty,
      includeCatalogProductDetails: true,
      merchantLocationKey: config.getEBAY_LOCATION_KEY(),
      categoryId: finalListing.categoryId,
      listingDescription: finalListing.description,
      listingDuration: "GTC",
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentId,
        paymentPolicyId: policies.paymentId,
        returnPolicyId: policies.returnId
      },
      pricingSummary: {
        price: { currency: "USD", value: listingPrice.toFixed(2) }
      }
    };

    if (bestOfferTerms) {
      offerPayload.bestOfferTerms = bestOfferTerms;
    }

    const offerResponse = await ebayClient.ebayRequest("/offer", "POST", offerPayload);
    const publishResponse = await ebayClient.ebayRequest(`/offer/${offerResponse.offerId}/publish`, "POST");

    if (promotionBidPercentage !== null && publishResponse.listingId) {
      ebayClient.promoteListingStandard(publishResponse.listingId, payload.sku, promotionBidPercentage);
    }

    const { crossPostResults, shopifyId, woocommerceId, etsyId } =
      await runRequestedCrossPosts(payload, finalListing, finalImageUrls, payload.sku);

    // Update SQLite entry
    item.listingId = publishResponse.listingId;
    item.offerId = offerResponse.offerId;
    item.shopifyId = shopifyId || item.shopifyId || null;
    item.woocommerceId = woocommerceId || item.woocommerceId || null;
    item.etsyId = etsyId || item.etsyId || null;
    item.status = "ACTIVE";
    item.timestamp = new Date().toISOString();
    utils.persistListing(item);

    res.json({
      success: true,
      listingId: publishResponse.listingId,
      shopifyId,
      woocommerceId,
      etsyId,
      crossPostResults
    });
  } catch (e) {
    next(e);
  }
});

// API: End live listing
router.post('/api/end-listing', async (req, res, next) => {
  try {
    const payload = req.body;
    if (typeof payload !== 'object' || payload === null || !payload.sku || typeof payload.sku !== 'string') {
      return res.status(400).json({ error: "Invalid payload: Missing SKU field" });
    }

    await ebayClient.refreshEbayAccessToken();
    const listingId = await ebayClient.endListingOnEbay(payload.sku, payload.offerId);
    
    // Update local history status
    const item = db.listings.findBySku(payload.sku);
    if (item) {
      item.status = "ENDED";
      item.timestamp = new Date().toISOString();
      utils.persistListing(item);
    }

    res.json({ success: true, listingId });
  } catch (e) {
    next(e);
  }
});

// API: Relist ended listing
router.post('/api/relist', async (req, res, next) => {
  try {
    const { sku } = req.body;
    if (!sku) {
      return res.status(400).json({ error: "Missing required parameter: sku" });
    }

    const existing = db.listings.findBySku(sku);
    if (!existing) {
      return res.status(404).json({ error: "SKU not found" });
    }

    const newSku = `${config.getSKU_PREFIX()}SKU-${Date.now()}`;
    const newDraft = {
      ...existing,
      sku: newSku,
      status: "DRAFT",
      listingId: null,
      offerId: null,
      timestamp: new Date().toISOString(),
      listingDetails: existing.listingDetails ? {
        ...existing.listingDetails,
        suggestedPrice: existing.price
      } : null
    };

    utils.persistListing(newDraft);
    res.json({ success: true, sku: newSku });
  } catch (e) {
    next(e);
  }
});

// API: Autosave draft listing
router.post('/api/draft/autosave', validate(DraftAutosaveSchema), async (req, res, next) => {
  try {
    const payload = req.body;
    const finalListing = payload.listing;
    const sku = payload.sku;

    if (finalListing) {
      geminiClient.validateAndFixListingSchema(finalListing);
      if (finalListing.description) {
        finalListing.description = utils.stripScriptsAndIframes(finalListing.description);
      }

      const listingDetails = {
        ...finalListing,
        imageUrls: payload.imageUrls || []
      };

      const existing = db.listings.findBySku(sku);
      if (existing) {
        existing.timestamp = new Date().toISOString();
        existing.title = finalListing.title || existing.title;
        existing.price = parseFloat(finalListing.suggestedPrice) || existing.price || 0;
        existing.categoryId = finalListing.categoryId || existing.categoryId;
        existing.brand = finalListing.brand || existing.brand || "Generic";
        existing.listingDetails = listingDetails;
        utils.persistListing(existing);
      } else {
        utils.saveListingToHistory(sku, null, finalListing.title, finalListing.suggestedPrice || 0, finalListing.categoryId, null, null, "DRAFT", listingDetails);
      }
    }
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// API: Get Listings History
router.get('/api/history', async (req, res, next) => {
  try {
    const data = db.listings.findAll();
    res.json({
      listings: data,
      shopifyShopName: config.getSHOPIFY_SHOP_NAME() || null,
      woocommerceUrl: config.getWOOCOMMERCE_URL() || null,
      etsyShopId: config.getETSY_SHOP_ID() || null
    });
  } catch (e) {
    next(e);
  }
});

// API: Delete Listing Entry
router.delete('/api/history', async (req, res, next) => {
  try {
    const targetSku = req.query.sku;
    if (!targetSku) {
      return res.status(400).json({ error: "Missing required query parameter: sku" });
    }

    const deleted = utils.removeListing(targetSku);
    if (!deleted) {
      return res.status(404).json({ error: "SKU not found in history" });
    }

    utils.logAudit("INFO", `Deleted SKU ${targetSku} from history`);
    res.json({ success: true, message: `SKU ${targetSku} successfully removed.` });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
