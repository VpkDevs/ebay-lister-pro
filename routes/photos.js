/**
 * @file routes/photos.js
 * @description Express router for the autonomous photo-sourcing pipeline.
 * Provides POST /api/photos/auto-source which hunts, downloads, spruces,
 * and uploads product photos with zero seller effort.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const photoSourcing = require('../lib/photoSourcing');
const utils = require('../utils');

const router = express.Router();

// ── Zod validation schema ────────────────────────────────────────────────────

const SpruceOptsSchema = z.object({
  bgRemove:        z.boolean().optional(),
  bgStyle:         z.enum(['white', 'gradient', 'transparent']).optional(),
  colorCorrection: z.boolean().optional(),
  canvasSize:      z.number().int().refine(v => [800, 1200, 1600].includes(v)).optional(),
  watermark:       z.boolean().optional(),
  watermarkText:   z.string().max(120).optional(),
  watermarkPosition: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left', 'diagonal', 'diagonal-tile']).optional()
}).strict();

const AutoSourceSchema = z.object({
  title:      z.string().min(2).max(250),
  brand:      z.string().max(80).optional().nullable(),
  model:      z.string().max(80).optional().nullable(),
  upc:        z.string().regex(/^\d{0,14}$/).optional().nullable(),
  maxPhotos:  z.number().int().min(1).max(24).default(8),
  spruceOpts: SpruceOptsSchema.optional().default({})
});

// ── Route: POST /api/photos/auto-source ─────────────────────────────────────

/**
 * @route  POST /api/photos/auto-source
 * @desc   Autonomously source, download, spruce, and upload product photos.
 *         Searches eBay Catalog, UPCItemDB, Open Food Facts, Bing (optional),
 *         Google CSE (optional), and DuckDuckGo as a zero-key fallback.
 *
 * @body   { title, brand?, model?, upc?, maxPhotos?, spruceOpts? }
 * @returns { success, photos[], sources{}, totalCandidates, message }
 */
router.post('/api/photos/auto-source', async (req, res, next) => {
  // Validate input
  const parseResult = AutoSourceSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request payload',
      details: parseResult.error.flatten().fieldErrors
    });
  }

  const { title, brand, model, upc, maxPhotos, spruceOpts } = parseResult.data;

  utils.logAudit('INFO', `[AutoSource] Request: title="${title}", brand="${brand}", upc="${upc}", max=${maxPhotos}`);

  try {
    const result = await photoSourcing.sourceProductPhotos({
      title,
      brand: brand || null,
      model: model || null,
      upc: upc || null,
      maxPhotos,
      spruceOpts
    });

    const activeSources = Object.keys(result.sources);
    const message = result.photos.length > 0
      ? `Found and processed ${result.photos.length} photo${result.photos.length !== 1 ? 's' : ''} from ${activeSources.length} source${activeSources.length !== 1 ? 's' : ''}.`
      : `No photos could be sourced for "${title}". Try adjusting the product title or adding a UPC.`;

    res.json({
      success: result.photos.length > 0,
      photos: result.photos,
      sources: result.sources,
      totalCandidates: result.totalCandidates,
      message
    });
  } catch (err) {
    next(err);
  }
});

// ── Route: GET /api/photos/sources ──────────────────────────────────────────

/**
 * @route  GET /api/photos/sources
 * @desc   Returns which photo sources are currently active/configured.
 *         Useful for the frontend to show the user which sources will be searched.
 */
router.get('/api/photos/sources', (req, res) => {
  res.json({
    sources: [
      {
        id: 'ebay_upc',
        name: 'eBay Catalog (UPC)',
        description: 'Official product images from the eBay Product Catalog via GTIN/UPC lookup.',
        active: true,
        requiresKey: false,
        requiresUpc: true
      },
      {
        id: 'upcitemdb',
        name: 'UPCItemDB',
        description: 'Product database with manufacturer images indexed by UPC/EAN.',
        active: true,
        requiresKey: false,
        requiresUpc: true
      },
      {
        id: 'open_food_facts',
        name: 'Open Food Facts',
        description: 'Open product database with crowd-sourced product photos (best for food/grocery).',
        active: true,
        requiresKey: false,
        requiresUpc: true
      },
      {
        id: 'ebay_catalog',
        name: 'eBay Catalog (Keywords)',
        description: 'Stock photos from eBay\'s product catalog searched by title keywords.',
        active: true,
        requiresKey: false,
        requiresUpc: false
      },
      {
        id: 'bing_images',
        name: 'Bing Image Search',
        description: 'High-resolution product photos from Bing Image Search (Azure Cognitive Services).',
        active: !!process.env.BING_SEARCH_API_KEY,
        requiresKey: true,
        envKey: 'BING_SEARCH_API_KEY',
        requiresUpc: false
      },
      {
        id: 'google_cse',
        name: 'Google Custom Search',
        description: 'Product photos via Google Custom Search Engine API.',
        active: !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_ID),
        requiresKey: true,
        envKey: 'GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID',
        requiresUpc: false
      },
      {
        id: 'duckduckgo',
        name: 'DuckDuckGo (Fallback)',
        description: 'Zero-key fallback image search via DuckDuckGo Instant Answer API.',
        active: true,
        requiresKey: false,
        requiresUpc: false
      }
    ]
  });
});

module.exports = router;
