/**
 * @file routes/images.js
 * @description Express router for image handling and analysis.
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const utils = require('../utils');
const ebayClient = require('../ebayClient');
const geminiClient = require('../geminiClient');
const imageDownloader = require('../lib/imageDownloader');
const imagePipeline = require('../lib/imagePipeline');
const { uploadImage, uploadImagesConcurrently } = require('../lib/imageHelpers');

const router = express.Router();

const SPRUCE_BG_STYLES = new Set(['white', 'gradient', 'transparent']);
const SPRUCE_WATERMARK_POSITIONS = new Set([
  'bottom-right', 'bottom-left', 'top-right', 'top-left', 'diagonal', 'diagonal-tile'
]);

/**
 * Sanitizes spruce/image pipeline options from client payloads.
 * @param {object} raw
 * @returns {object}
 */
function sanitizeSpruceOptions(raw = {}) {
  const opts = {};
  if (typeof raw.watermarkText === 'string') {
    opts.watermarkText = raw.watermarkText.trim().slice(0, 120);
  }
  if (typeof raw.watermarkPosition === 'string' && SPRUCE_WATERMARK_POSITIONS.has(raw.watermarkPosition)) {
    opts.watermarkPosition = raw.watermarkPosition;
  }
  if (typeof raw.bgStyle === 'string' && SPRUCE_BG_STYLES.has(raw.bgStyle)) {
    opts.bgStyle = raw.bgStyle;
  }
  if (typeof raw.colorCorrection === 'boolean') opts.colorCorrection = raw.colorCorrection;
  if (typeof raw.bgRemove === 'boolean') opts.bgRemove = raw.bgRemove;
  if (typeof raw.watermark === 'boolean') opts.watermark = raw.watermark;

  const rotate = parseInt(raw.rotate, 10);
  if ([0, 90, 180, 270].includes(rotate)) opts.rotate = rotate;

  const canvasSize = parseInt(raw.canvasSize, 10);
  if ([800, 1200, 1600].includes(canvasSize)) opts.canvasSize = canvasSize;

  const brightness = parseFloat(raw.brightness);
  if (!Number.isNaN(brightness)) opts.brightness = Math.min(1.5, Math.max(0.5, brightness));

  const saturation = parseFloat(raw.saturation);
  if (!Number.isNaN(saturation)) opts.saturation = Math.min(1.5, Math.max(0.5, saturation));

  if (raw.crop && typeof raw.crop === 'object') {
    const x = Number(raw.crop.x);
    const y = Number(raw.crop.y);
    const w = Number(raw.crop.w);
    const h = Number(raw.crop.h);
    if ([x, y, w, h].every(v => Number.isFinite(v)) && w > 0 && h > 0) {
      opts.crop = {
        x: Math.min(0.99, Math.max(0, x)),
        y: Math.min(0.99, Math.max(0, y)),
        w: Math.min(1, Math.max(0.01, w)),
        h: Math.min(1, Math.max(0.01, h))
      };
    }
  }

  return opts;
}

/**
 * Materializes an image reference (base64, /uploads/ path, or remote URL) into a verified temp file.
 * @param {string} imageRef
 * @param {number} index
 * @returns {Promise<{fileBuffer: Buffer, tempPaths: string[]}>}
 */
async function materializeImageReference(imageRef, index) {
  if (typeof imageRef !== 'string' || !imageRef.trim()) {
    throw new Error(`Image ${index + 1}: empty or invalid reference`);
  }

  const tempPaths = [];
  let workingPath;

  if (imageRef.startsWith('data:image')) {
    const base64Data = imageRef.replace(/^data:image\/\w+;base64,/, "");
    if (!base64Data) {
      throw new Error(`Image ${index + 1}: invalid base64 payload`);
    }
    const fileBuffer = Buffer.from(base64Data, 'base64');
    if (fileBuffer.length === 0) {
      throw new Error(`Image ${index + 1}: decoded image is empty`);
    }
    if (fileBuffer.length > 12 * 1024 * 1024) {
      throw new Error(`Image ${index + 1}: exceeds 12MB limit`);
    }

    workingPath = path.join(config.uploadTempDir, `web-upload-${Date.now()}-${index}.jpg`);
    fs.writeFileSync(workingPath, fileBuffer);
    tempPaths.push(workingPath);
  } else if (imageRef.startsWith('/uploads/')) {
    workingPath = utils.resolveUploadsPath(imageRef);
    if (!fs.existsSync(workingPath)) {
      throw new Error(`Image ${index + 1}: local file not found`);
    }
    utils.verifyImageFile(workingPath);
  } else if (/^https?:\/\//i.test(imageRef)) {
    utils.validateRemoteImageUrl(imageRef);
    workingPath = await imageDownloader.downloadAndCacheImage(imageRef);
    tempPaths.push(workingPath);
  } else {
    throw new Error(`Image ${index + 1}: unsupported format (use upload, import, or data URL)`);
  }

  try {
    utils.verifyImageFile(workingPath);
  } catch (imgErr) {
    tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    throw new Error(`Image ${index + 1}: ${imgErr.message}`);
  }

  const optimizedFilename = `opt-web-upload-${Date.now()}-${index}.jpg`;
  const optimizedFilePath = path.join(config.uploadTempDir, optimizedFilename);

  try {
    await utils.optimizeImageNative(workingPath, optimizedFilePath, 1600);
    if (tempPaths.includes(workingPath)) {
      try { fs.unlinkSync(workingPath); } catch (e) {}
    }
    tempPaths.push(optimizedFilePath);
    return { fileBuffer: fs.readFileSync(optimizedFilePath), tempPaths };
  } catch (optErr) {
    utils.logAudit("WARN", `Failed to optimize image ${path.basename(workingPath)}: ${optErr.message}`);
    if (!tempPaths.includes(workingPath)) tempPaths.push(workingPath);
    return { fileBuffer: fs.readFileSync(workingPath), tempPaths };
  }
}

// API: Import and spruce remote image URLs
router.post('/api/images/import-urls', async (req, res, next) => {
  try {
    const { urls, options: rawOptions = {} } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "Invalid payload: urls must be a non-empty array" });
    }
    if (urls.length > utils.MAX_LISTING_IMAGES) {
      return res.status(400).json({ error: `Too many URLs (max ${utils.MAX_LISTING_IMAGES})` });
    }

    const options = sanitizeSpruceOptions(rawOptions);

    const validated = [];
    const rejected = [];
    for (const rawUrl of urls) {
      try {
        validated.push({ input: String(rawUrl).trim(), url: utils.validateRemoteImageUrl(String(rawUrl)) });
      } catch (err) {
        rejected.push({ input: String(rawUrl).slice(0, 200), error: err.message });
      }
    }

    if (validated.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No valid URLs to import",
        rejected
      });
    }

    const responsePayload = [];
    for (const entry of validated) {
      try {
        const entryFiles = await imageDownloader.downloadUrlsConcurrently([entry.url], options);
        if (entryFiles.length === 0) {
          responsePayload.push({
            success: false,
            sourceUrl: entry.input,
            error: 'No images could be downloaded from this URL'
          });
          continue;
        }

        for (const filepath of entryFiles) {
          try {
            const result = await imagePipeline.processImageSource(filepath, options);
            const localUrl = `/uploads/processed/${path.basename(result.outputPath)}`;
            let uploadedUrl = null;
            try {
              uploadedUrl = await uploadImage(result.outputPath);
            } catch (uploadErr) {
              utils.logAudit("WARN", `External upload failed for imported image; local URL available: ${uploadErr.message}`);
            }
            responsePayload.push({
              success: true,
              sourceUrl: entry.input,
              localUrl,
              uploadedUrl,
              metadata: result.metadata
            });
          } catch (procErr) {
            responsePayload.push({
              success: false,
              sourceUrl: entry.input,
              error: procErr.message
            });
          }
        }
      } catch (entryErr) {
        responsePayload.push({
          success: false,
          sourceUrl: entry.input,
          error: entryErr.message
        });
      }
    }

    rejected.forEach(r => {
      responsePayload.push({ success: false, sourceUrl: r.input, error: r.error });
    });

    const successCount = responsePayload.filter(r => r.success).length;
    res.json({
      success: successCount > 0,
      imported: successCount,
      failed: responsePayload.length - successCount,
      rejected,
      results: responsePayload
    });
  } catch (e) {
    next(e);
  }
});

// API: Spruce image with custom options (crop, watermark, color Correction, bgRemove)
router.post('/api/images/spruce', async (req, res, next) => {
  try {
    const { image, options: rawOptions = {} } = req.body;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: "Missing required field: image" });
    }

    const options = sanitizeSpruceOptions(rawOptions);
    let inputSource;
    let tempFilePath = null;

    if (image.startsWith('data:image')) {
      const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
      if (!base64Data) {
        return res.status(400).json({ error: "Invalid base64 image payload" });
      }
      const fileBuffer = Buffer.from(base64Data, 'base64');
      if (fileBuffer.length === 0 || fileBuffer.length > 12 * 1024 * 1024) {
        return res.status(400).json({ error: "Image payload is empty or exceeds 12MB" });
      }
      tempFilePath = path.join(config.uploadTempDir, `spruce-upload-${Date.now()}.jpg`);
      fs.writeFileSync(tempFilePath, fileBuffer);
      utils.verifyImageFile(tempFilePath);
      inputSource = tempFilePath;
    } else if (image.startsWith('/uploads/')) {
      inputSource = utils.resolveUploadsPath(image);
      if (!fs.existsSync(inputSource)) {
        return res.status(404).json({ error: "Source image not found" });
      }
      utils.verifyImageFile(inputSource);
    } else if (/^https?:\/\//i.test(image)) {
      utils.validateRemoteImageUrl(image);
      inputSource = await imageDownloader.downloadAndCacheImage(image);
      tempFilePath = inputSource;
    } else {
      return res.status(400).json({ error: "Unsupported image reference format" });
    }

    const result = await imagePipeline.processImageSource(inputSource, options);
    const localUrl = `/uploads/processed/${path.basename(result.outputPath)}`;
    let uploadedUrl = null;
    try {
      uploadedUrl = await uploadImage(result.outputPath);
    } catch (uploadErr) {
      utils.logAudit("WARN", `External upload failed after spruce; local URL available: ${uploadErr.message}`);
    }

    if (tempFilePath && tempFilePath !== inputSource && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }

    res.json({
      success: true,
      localUrl,
      uploadedUrl,
      metadata: result.metadata
    });
  } catch (e) {
    next(e);
  }
});

// API: Analyze product photos
router.post('/api/analyze', async (req, res, next) => {
  try {
    const payload = req.body;

    if (typeof payload !== 'object' || payload === null) {
      return res.status(400).json({ error: "Invalid payload: must be a JSON object" });
    }
    if (!payload.images || !Array.isArray(payload.images) || payload.images.length === 0) {
      return res.status(400).json({ error: "Missing or empty images array" });
    }
    if (payload.images.length > utils.MAX_LISTING_IMAGES) {
      return res.status(400).json({ error: `Too many images (max ${utils.MAX_LISTING_IMAGES})` });
    }
    if (payload.barcode !== undefined && payload.barcode !== null && typeof payload.barcode !== 'string') {
      return res.status(400).json({ error: "Invalid barcode: must be a string" });
    }
    if (payload.notes !== undefined && payload.notes !== null && typeof payload.notes !== 'string') {
      return res.status(400).json({ error: "Invalid notes: must be a string" });
    }
    if (payload.persona !== undefined && payload.persona !== null && typeof payload.persona !== 'string') {
      return res.status(400).json({ error: "Invalid persona: must be a string" });
    }
    if (payload.template !== undefined && payload.template !== null && typeof payload.template !== 'string') {
      return res.status(400).json({ error: "Invalid template: must be a string" });
    }

    await ebayClient.refreshEbayAccessToken();

    let upcData = null;
    if (payload.barcode) {
      upcData = await ebayClient.lookupUPCOnEbay(payload.barcode);
    }

    const fileBuffers = [];
    const tempPaths = [];

    for (let i = 0; i < payload.images.length; i++) {
      let materialized;
      try {
        materialized = await materializeImageReference(payload.images[i], i);
      } catch (imgErr) {
        tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
        return res.status(400).json({ error: imgErr.message });
      }

      fileBuffers.push(materialized.fileBuffer);
      tempPaths.push(...materialized.tempPaths);
    }

    const listing = await geminiClient.runAIOrchestration(
      fileBuffers,
      tempPaths.map(p => path.basename(p)),
      payload.barcode,
      payload.notes,
      upcData,
      { persona: payload.persona, template: payload.template }
    );
    const categorySuggestions = await ebayClient.getCategorySuggestions(listing.title);
    const imageUrls = await uploadImagesConcurrently(tempPaths, 2);

    tempPaths.forEach(p => {
      try { fs.unlinkSync(p); } catch (e) {}
    });

    let stockPhotos = [];
    if (upcData && Array.isArray(upcData.stockImageUrls)) {
      stockPhotos = upcData.stockImageUrls;
    }
    if (stockPhotos.length === 0) {
      stockPhotos = await ebayClient.searchCatalogStockPhotos(listing.title);
    }

    const comps = listing.compsPriceInfo || await ebayClient.searchEbayComps(listing.title, listing.condition);
    if (listing.compsPriceInfo) {
      delete listing.compsPriceInfo;
    }

    res.json({ listing, imageUrls, categorySuggestions, comps, stockPhotos });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
