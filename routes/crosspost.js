/**
 * @file routes/crosspost.js
 * @description Express router for cross-posting channels (Shopify, WooCommerce, Etsy, Mercari, Poshmark) and the DLQ sync queue.
 */

'use strict';

const express = require('express');
const config = require('../config');
const utils = require('../utils');
const ebayClient = require('../ebayClient');
const crossPost = require('../crossPost');

const router = express.Router();

// API: WooCommerce Cross-Post
router.post('/api/publish/woocommerce', async (req, res, next) => {
  let { sku, listing, imageUrls } = req.body;
  try {
    const wcUrlStr = config.getWOOCOMMERCE_URL();
    const wcKey = config.getWOOCOMMERCE_KEY();
    const wcSecret = config.getWOOCOMMERCE_SECRET();

    if (!wcUrlStr || !wcKey || !wcSecret) {
      return res.status(400).json({ error: "WooCommerce not configured." });
    }

    const wcPayload = {
      name: listing.title,
      type: "simple",
      regular_price: String(listing.suggestedPrice),
      description: listing.description,
      short_description: "Multichannel listing from eBay Lister",
      manage_stock: true,
      stock_quantity: 1,
      sku: sku,
      images: (imageUrls || []).map(url => ({ src: url }))
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
    if (!wcRes.ok) {
      throw new Error(`WooCommerce API error: ${JSON.stringify(wcData)}`);
    }

    const history = utils.readJsonFileSecure(config.historyPath, []);
    const item = history.find(i => i.sku === sku);
    if (item) {
      item.woocommerceId = String(wcData.id);
      utils.writeJsonFileSecure(config.historyPath, history);
    }

    res.json({ success: true, id: wcData.id });
  } catch (e) {
    await crossPost.addToDlq("woocommerce", sku, listing, imageUrls || [], e.message);
    next(e);
  }
});

// API: Etsy Cross-Post
router.post('/api/publish/etsy', async (req, res, next) => {
  let { sku, listing } = req.body;
  try {
    const etsyShopId = config.getETSY_SHOP_ID();
    const etsyToken = config.getETSY_ACCESS_TOKEN();
    const etsyClientId = config.getEBAY_CLIENT_ID(); // Uses eBay client id as app key if shared or fallback

    if (!etsyShopId || !etsyToken) {
      return res.status(400).json({ error: "Etsy shop settings not configured." });
    }

    const etsyPayload = {
      quantity: 1,
      title: listing.title.slice(0, 140),
      description: listing.description,
      price: listing.suggestedPrice,
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: 1,
      is_personalizable: false
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
    if (!etsyRes.ok) {
      throw new Error(`Etsy API error: ${JSON.stringify(etsyData)}`);
    }

    const history = utils.readJsonFileSecure(config.historyPath, []);
    const item = history.find(i => i.sku === sku);
    if (item) {
      item.etsyId = String(etsyData.listing_id);
      utils.writeJsonFileSecure(config.historyPath, history);
    }

    res.json({ success: true, id: etsyData.listing_id });
  } catch (e) {
    await crossPost.addToDlq("etsy", sku, listing, [], e.message);
    next(e);
  }
});

// API: Export to Mercari & Poshmark (helper formats payload for clipboard copy-paste)
const handleExport = (platform) => {
  return (req, res) => {
    try {
      const { sku } = req.body;
      const history = utils.readJsonFileSecure(config.historyPath, []);
      const item = history.find(i => i.sku === sku);
      if (!item) {
        return res.status(404).json({ error: "SKU not found." });
      }

      const exportData = {
        title: item.title,
        description: item.description,
        price: item.price,
        sku: item.sku,
        brand: item.brand || "Generic",
        suggestedTags: item.title.split(' ').slice(0, 3).join(', ')
      };

      res.json({
        success: true,
        platform,
        sku,
        copyPaste: exportData,
        images: item.imageUrls || []
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
};

router.post('/api/export/mercari', handleExport('Mercari'));
router.post('/api/export/poshmark', handleExport('Poshmark'));

// API: Get DLQ entries
router.get('/api/dlq', async (req, res, next) => {
  try {
    const summary = await crossPost.getDlqSummary();
    const entries = await crossPost.getDlqEntries();
    res.json({ success: true, summary, entries });
  } catch (err) {
    next(err);
  }
});

// API: Process pending syncs in DLQ
router.post('/api/dlq/process', async (req, res, next) => {
  try {
    const result = await crossPost.processPendingSyncsDlq();
    const summary = await crossPost.getDlqSummary();
    res.json({ success: true, result, summary });
  } catch (err) {
    next(err);
  }
});

// API: Take specific actions on DLQ jobs (retry, dismiss, clear)
router.post('/api/dlq/action', async (req, res, next) => {
  try {
    const { action, sku, platform, force, confirm } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Missing required field: action' });
    }

    if (action === 'clear') {
      if (!confirm) {
        return res.status(400).json({ error: 'Set confirm: true to clear the entire sync queue' });
      }
      const removedCount = await crossPost.clearDlq();
      return res.json({ success: true, removedCount, summary: await crossPost.getDlqSummary() });
    }

    if (!sku || !platform) {
      return res.status(400).json({ error: 'Missing required fields: sku, platform' });
    }

    if (action === 'retry') {
      const result = await crossPost.retryDlqJob(sku, platform, { force: !!force });
      const summary = await crossPost.getDlqSummary();
      return res.json({ success: true, result, summary });
    }

    if (action === 'dismiss') {
      const removed = await crossPost.removeFromDlq(sku, platform);
      if (!removed) {
        return res.status(404).json({ error: 'DLQ job not found' });
      }
      const summary = await crossPost.getDlqSummary();
      return res.json({ success: true, summary });
    }

    res.status(400).json({ error: 'Invalid action. Use retry, dismiss, or clear.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
