const express = require('express');
const config = require('../config');
const utils = require('../utils');
const ebayClient = require('../ebayClient');
const geminiClient = require('../geminiClient');

const router = express.Router();

// API: Search category suggestions
router.get('/api/categories/search', async (req, res, next) => {
  const q = req.query.q;
  if (!q) {
    return res.status(400).json({ error: "Missing query parameter: q" });
  }
  try {
    const suggestions = await ebayClient.getCategorySuggestions(q);
    res.json(suggestions);
  } catch (err) {
    next(err);
  }
});

// API: Get location info
router.get('/api/ebay/location', async (req, res, next) => {
  try {
    const key = config.getEBAY_LOCATION_KEY();
    const data = await ebayClient.getInventoryLocation(key);
    res.json(data);
  } catch (err) {
    res.json({ error: err.message, locationKey: config.getEBAY_LOCATION_KEY() });
  }
});

// API: Save/Create location info
router.post('/api/ebay/location', async (req, res, next) => {
  try {
    const payload = req.body;
    const key = payload.locationKey || config.getEBAY_LOCATION_KEY();
    const result = await ebayClient.createInventoryLocation(key, payload.locationDetails);
    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
});

// API: Get condition policies per category
router.get('/api/ebay/conditions', async (req, res, next) => {
  const categoryId = req.query.categoryId;
  if (!categoryId) {
    return res.status(400).json({ error: "Missing categoryId" });
  }
  try {
    const conditions = await ebayClient.getItemConditionPolicies(categoryId);
    res.json(conditions);
  } catch (err) {
    next(err);
  }
});

// API: Get item aspects metadata per category
router.get('/api/ebay/aspects', async (req, res, next) => {
  const categoryId = req.query.categoryId;
  if (!categoryId) {
    return res.status(400).json({ error: "Missing categoryId" });
  }
  try {
    const metadata = await ebayClient.getItemAspectsMetadata(categoryId);
    res.json(metadata);
  } catch (err) {
    next(err);
  }
});

// API: Fetch eBay custom business policies
router.get('/api/ebay/policies', async (req, res, next) => {
  try {
    const policies = await ebayClient.getEbayPolicies();
    res.json(policies);
  } catch (err) {
    next(err);
  }
});

// API: Fetch eBay Marketing Campaigns Summary
router.get('/api/ebay/marketing/summary', async (req, res, next) => {
  try {
    const summary = await ebayClient.getMarketingSummary();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// API: Import listings from eBay Browse API ("Sell Similar")
router.get('/api/ebay/import', async (req, res, next) => {
  const targetInput = req.query.itemIdOrUrl || "";

  // Parse item ID
  const match = targetInput.match(/(?:\/itm\/|active\/|item\/|v1\|)?(\d{11,13})/i);
  let itemId = match ? match[1] : targetInput.trim();
  const isOriginalKeywordSearch = !match;

  const handleGeminiListingFallback = async (keywords) => {
    const geminiListing = await geminiClient.generateListingFromKeywords(keywords);
    let stockPhotos = [];
    try {
      stockPhotos = await ebayClient.searchCatalogStockPhotos(geminiListing.title || keywords);
    } catch (pErr) {
      utils.logAudit("WARN", `Failed to fetch stock photos for Gemini generated listing: ${pErr.message}`);
    }
    return {
      title: geminiListing.title,
      suggestedPrice: geminiListing.suggestedPrice,
      condition: geminiListing.condition,
      brand: geminiListing.brand,
      model: geminiListing.model,
      weightMajor: geminiListing.weightMajor || 1,
      weightMinor: geminiListing.weightMinor || 0,
      packageLength: geminiListing.packageLength || 10,
      packageWidth: geminiListing.packageWidth || 8,
      packageHeight: geminiListing.packageHeight || 6,
      description: geminiListing.description,
      categoryId: geminiListing.categoryId || "111422",
      aspects: geminiListing.aspects || {},
      imageUrls: stockPhotos
    };
  };

  if (!itemId || !/^\d{11,13}$/.test(itemId)) {
    if (!targetInput.trim()) {
      return res.status(400).json({ error: "Please enter an eBay Item ID, URL, or product keywords." });
    }
    try {
      const foundId = await ebayClient.searchItemIdByKeywords(targetInput.trim());
      if (foundId) {
        itemId = foundId;
      }
    } catch (err) {
      utils.logAudit("WARN", `eBay Browse API search failed for keywords "${targetInput}": ${err.message}. Falling back to Gemini AI generation.`);
    }
  }

  // If we don't have a valid Item ID after searching, use Gemini AI generation directly
  if (!itemId || !/^\d{11,13}$/.test(itemId)) {
    utils.logAudit("INFO", `No valid Item ID found. Using Gemini AI generation for "${targetInput}"`);
    try {
      const data = await handleGeminiListingFallback(targetInput.trim());
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: `Listing generation failed: ${err.message}` });
    }
  }

  try {
    const item = await ebayClient.getItemFromBrowse(itemId);

    const brand = item.brand || "";
    const model = item.mpn || item.model || "";

    const aspects = {};
    if (Array.isArray(item.localizedAspects)) {
      item.localizedAspects.forEach(a => {
        aspects[a.name] = a.value;
      });
    }

    const imageUrls = [];
    if (item.image && item.image.imageUrl) {
      imageUrls.push(item.image.imageUrl);
    }
    if (Array.isArray(item.additionalImages)) {
      item.additionalImages.forEach(img => {
        if (img.imageUrl && !imageUrls.includes(img.imageUrl)) {
          imageUrls.push(img.imageUrl);
        }
      });
    }

    const listingData = {
      title: item.title || "",
      suggestedPrice: item.price ? parseFloat(item.price.value) : 10.00,
      condition: "USED_GOOD",
      brand: brand,
      model: model,
      categoryId: item.categoryId || "",
      weightMajor: 1,
      weightMinor: 0,
      packageLength: 10,
      packageWidth: 8,
      packageHeight: 6,
      description: item.description || "",
      aspects: aspects,
      imageUrls: imageUrls
    };

    res.json(listingData);
  } catch (err) {
    utils.logAudit("WARN", `Failed to get item details from Browse API: ${err.message}`);
    if (isOriginalKeywordSearch) {
      utils.logAudit("INFO", `Falling back to Gemini AI generation for "${targetInput}"`);
      try {
        const data = await handleGeminiListingFallback(targetInput.trim());
        return res.json(data);
      } catch (geminiErr) {
        return res.status(500).json({ error: `Listing generation failed: ${geminiErr.message}` });
      }
    } else {
      next(err);
    }
  }
});

// API: Get VeRO Brands
router.get('/api/vero-brands', (req, res) => {
  res.json({ brands: config.getVERO_BRANDS() });
});

module.exports = router;
