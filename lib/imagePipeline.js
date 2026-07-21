/**
 * @file lib/imagePipeline.js
 * @description Advanced studio-grade image transcoding, color correction, content auto-framing, local AI background removal, and configurable watermark positioning.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const utils = require('../utils');
const config = require('../config');

const DEFAULT_LOCAL_BG_MODELS = ['Xenova/modnet'];
let localBgRemovalPipelinePromise = null;
let localBgRemovalModelId = null;

class ImagePipelineError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ImagePipelineError';
    this.details = details;
  }
}

function getLocalBgModelCandidates() {
  const configured = process.env.LOCAL_BG_REMOVAL_MODEL;
  if (!configured) return DEFAULT_LOCAL_BG_MODELS;
  const requested = configured.split(',').map(s => s.trim()).filter(Boolean);
  return [...requested, ...DEFAULT_LOCAL_BG_MODELS.filter(model => !requested.includes(model))];
}

async function getLocalBgRemovalPipeline() {
  if (process.env.LOCAL_BG_REMOVAL_ENABLED === 'false') {
    throw new Error('Local background removal is disabled by LOCAL_BG_REMOVAL_ENABLED=false');
  }

  if (localBgRemovalPipelinePromise) return localBgRemovalPipelinePromise;

  localBgRemovalPipelinePromise = (async () => {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = process.env.TRANSFORMERS_CACHE || path.join(config.uploadTempDir, 'models', 'transformers');

    const errors = [];
    for (const modelId of getLocalBgModelCandidates()) {
      try {
        utils.logAudit('INFO', `Loading local background removal model: ${modelId}`);
        const pipe = await pipeline('background-removal', modelId, {
          device: process.env.LOCAL_BG_REMOVAL_DEVICE || 'cpu',
          dtype: process.env.LOCAL_BG_REMOVAL_DTYPE || 'fp32'
        });
        localBgRemovalModelId = modelId;
        utils.logAudit('INFO', `Loaded local background removal model: ${modelId}`);
        return pipe;
      } catch (err) {
        errors.push(`${modelId}: ${err.message}`);
        utils.logAudit('WARN', `Failed to load local background removal model ${modelId}: ${err.message}`);
      }
    }

    localBgRemovalPipelinePromise = null;
    throw new Error(`No local background removal model could be loaded. ${errors.join(' | ')}`);
  })();

  return localBgRemovalPipelinePromise;
}

/**
 * Removes backgrounds locally with a Hugging Face Transformers.js segmentation model.
 * RMBG-2.0 is tried first for quality, then RMBG-1.4 for wider runtime compatibility.
 * @param {Buffer} fileBuffer - Image buffer.
 * @returns {Promise<Buffer>} Transparent PNG buffer.
 */
async function localModelBgRemove(fileBuffer) {
  const { RawImage } = await import('@huggingface/transformers');
  const pipe = await getLocalBgRemovalPipeline();
  const { data, info } = await sharp(fileBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = new RawImage(Uint8ClampedArray.from(data), info.width, info.height, 3);
  const output = await pipe(image);
  const outputBuffer = await output.toSharp().png().toBuffer();
  utils.logAudit('INFO', `Local AI background removal complete using ${localBgRemovalModelId || 'unknown model'}.`);
  return outputBuffer;
}

/**
 * Performs local Chroma-Key background removal using Euclidean distance in RGB color space.
 * Samples corner pixels to estimate the background color and applies a transparency mask.
 * @param {Buffer} fileBuffer - Image buffer.
 * @param {number} [threshold=35] - Euclidean color-distance threshold.
 * @param {number} [feather=15] - Width of feathering transition.
 * @returns {Promise<Buffer>} Transparency masked PNG buffer.
 */
async function localChromaKeyBgRemove(fileBuffer, threshold = 35, feather = 15) {
  utils.logAudit("INFO", "Running local chroma-key background removal fallback...");
  try {
    const sharpImg = sharp(fileBuffer);
    const { data, info } = await sharpImg
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const channels = info.channels; // Expecting 4 (RGBA)

    // Sample corner indexes
    const idxTL = 0;
    const idxTR = (width - 1) * channels;
    const idxBL = (height - 1) * width * channels;
    const idxBR = ((height - 1) * width + (width - 1)) * channels;

    // Average corner colors to detect background
    const bgR = Math.round((data[idxTL] + data[idxTR] + data[idxBL] + data[idxBR]) / 4);
    const bgG = Math.round((data[idxTL + 1] + data[idxTR + 1] + data[idxBL + 1] + data[idxBR + 1]) / 4);
    const bgB = Math.round((data[idxTL + 2] + data[idxTR + 2] + data[idxBL + 2] + data[idxBR + 2]) / 4);

    utils.logAudit("INFO", `Detected local background color: RGB(${bgR}, ${bgG}, ${bgB})`);

    // Mask background pixels
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const dist = Math.sqrt((r - bgR) ** 2 + (g - bgG) ** 2 + (b - bgB) ** 2);

      if (dist < threshold) {
        data[i + 3] = 0; // Fully transparent
      } else if (dist < threshold + feather) {
        // Interpolate transparency for feathered edges
        const alpha = Math.round(((dist - threshold) / feather) * 255);
        data[i + 3] = Math.min(data[i + 3], alpha);
      }
    }

    return await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  } catch (err) {
    utils.logAudit("ERROR", `Local chroma-key failed: ${err.message}`);
    return fileBuffer;
  }
}

/**
 * Removes background using Photoroom API.
 * @param {Buffer} fileBuffer - Image buffer.
 * @param {string} apiKey - Photoroom API Key.
 * @returns {Promise<Buffer>} Transparent image buffer.
 */
async function photoroomBgRemove(fileBuffer, apiKey) {
  utils.logAudit("INFO", "Calling Photoroom API for background removal...");
  const boundary = `----WebKitFormBoundaryPhotoroom${Math.random().toString(36).substring(2)}`;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\r\n\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8')
  ]);

  const res = await axios.post('https://sdk.photoroom.com/v1/segment', bodyBuffer, {
    headers: {
      'x-api-key': apiKey,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    timeout: 25000,
    responseType: 'arraybuffer'
  });
  return res.data;
}

/**
 * Removes background using Remove.bg API.
 * @param {Buffer} fileBuffer - Image buffer.
 * @param {string} apiKey - Remove.bg API Key.
 * @returns {Promise<Buffer>} Transparent image buffer.
 */
async function removeBgApiRemove(fileBuffer, apiKey) {
  utils.logAudit("INFO", "Calling Remove.bg API for background removal...");
  const boundary = `----WebKitFormBoundaryRemoveBg${Math.random().toString(36).substring(2)}`;
  const header1 = `--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\nauto\r\n`;
  const header2 = `--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(header1, 'utf8'),
    Buffer.from(header2, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8')
  ]);

  const res = await axios.post('https://api.remove.bg/v1.0/removebg', bodyBuffer, {
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    timeout: 25000,
    responseType: 'arraybuffer'
  });
  return res.data;
}

/**
 * Composites the watermark overlay onto the canvas.
 * @param {sharp.Sharp} sharpImg - Sharp image wrapper.
 * @param {string} text - Watermark text content.
 * @param {string} position - Watermark placement (e.g. bottom-right, diagonal-tile).
 * @param {number} canvasSize - Total width/height of target canvas.
 * @returns {sharp.Sharp} Watermarked sharp image.
 */
function applyWatermarkOverlay(sharpImg, text, position, canvasSize) {
  const cleanText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  if (position === 'diagonal-tile') {
    const tileSvg = Buffer.from(`
      <svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="w_tile" width="350" height="250" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
            <text x="50" y="120" font-family="'Outfit', 'Inter', sans-serif" font-size="20px" font-weight="bold" fill="rgba(255, 255, 255, 0.18)">${cleanText}</text>
            <text x="50" y="120" font-family="'Outfit', 'Inter', sans-serif" font-size="20px" font-weight="bold" fill="rgba(0, 0, 0, 0.08)" dx="1" dy="1">${cleanText}</text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#w_tile)" />
      </svg>
    `.trim());
    return sharpImg.composite([{ input: tileSvg, top: 0, left: 0, blend: 'over' }]);
  }

  if (position === 'diagonal') {
    const diagSvg = Buffer.from(`
      <svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
        <text 
          x="50%" 
          y="50%" 
          font-family="'Outfit', 'Inter', sans-serif" 
          font-size="${Math.round(canvasSize * 0.06)}px" 
          font-weight="bold" 
          fill="rgba(255, 255, 255, 0.28)" 
          text-anchor="middle"
          transform="rotate(-45, ${canvasSize/2}, ${canvasSize/2})"
          stroke="rgba(0,0,0,0.1)"
          stroke-width="1"
        >
          ${cleanText}
        </text>
      </svg>
    `.trim());
    return sharpImg.composite([{ input: diagSvg, top: 0, left: 0, blend: 'over' }]);
  }

  const wWidth = Math.round(canvasSize * 0.35);
  const wHeight = Math.round(wWidth * 0.25);
  const cornerSvg = Buffer.from(`
    <svg width="${wWidth}" height="${wHeight}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="sh" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="2" dy="2" stdDeviation="2" flood-color="black" flood-opacity="0.6"/>
        </filter>
      </defs>
      <text 
        x="50%" 
        y="60%" 
        font-family="'Outfit', 'Inter', sans-serif" 
        font-size="${Math.round(wHeight * 0.45)}px" 
        font-weight="bold" 
        fill="rgba(255, 255, 255, 0.45)" 
        text-anchor="middle"
        filter="url(#sh)"
      >
        ${cleanText}
      </text>
    </svg>
  `.trim());

  const offset = 30;
  let top = canvasSize - wHeight - offset;
  let left = canvasSize - wWidth - offset;

  if (position === 'top-left') {
    top = offset;
    left = offset;
  } else if (position === 'top-right') {
    top = offset;
    left = canvasSize - wWidth - offset;
  } else if (position === 'bottom-left') {
    top = canvasSize - wHeight - offset;
    left = offset;
  }

  return sharpImg.composite([{
    input: cornerSvg,
    top,
    left,
    blend: 'over'
  }]);
}

/**
 * Core image editing and transcoding pipeline.
 * Processes local images or buffers and outputs a square optimized JPEG buffer.
 * @param {string|Buffer} input - File path or binary Buffer.
 * @param {object} options - Processing flags (resize, watermark, colorCorrection, bgRemove).
 * @returns {Promise<Buffer>} Optimized Jpeg image buffer.
 */
async function spruceImageBuffer(input, options = {}) {
  const canvasSize = options.canvasSize || 1600;
  const activeWatermark = options.watermarkText || config.getWATERMARK_TEXT() || "";
  const enableColorCorrection = options.colorCorrection !== false;
  const enableWatermark = options.watermark !== false && activeWatermark.trim().length > 0;
  const watermarkPosition = options.watermarkPosition || 'bottom-right';
  const bgRemove = !!options.bgRemove;
  const bgStyle = options.bgStyle || 'white'; // white | gradient | transparent

  try {
    let fileBuffer = typeof input === 'string' ? fs.readFileSync(input) : input;
    let originalSharp = sharp(fileBuffer);
    
    // Auto-rotate orientations
    originalSharp = originalSharp.rotate();

    // Apply custom crop if specified (values can be 0-1 percentage or absolute pixel coordinates)
    if (options.crop) {
      const meta = await originalSharp.metadata();
      let { x, y, w, h } = options.crop;

      // Detect percentage values
      if (x > 0 && x < 1) x = Math.round(x * meta.width);
      if (y > 0 && y < 1) y = Math.round(y * meta.height);
      if (w > 0 && w < 1) w = Math.round(w * meta.width);
      if (h > 0 && h < 1) h = Math.round(h * meta.height);

      // Force absolute integers
      x = Math.max(0, Math.round(x));
      y = Math.max(0, Math.round(y));
      w = Math.max(10, Math.round(w));
      h = Math.max(10, Math.round(h));

      // Constraint verification
      if (x + w > meta.width) w = meta.width - x;
      if (y + h > meta.height) h = meta.height - y;

      if (w > 10 && h > 10) {
        originalSharp = originalSharp.extract({ left: x, top: y, width: w, height: h });
      }
    }

    // Apply custom rotation (e.g. 90, 180, 270)
    if (options.rotate && [90, 180, 270].includes(parseInt(options.rotate))) {
      originalSharp = originalSharp.rotate(parseInt(options.rotate));
    }

    fileBuffer = await originalSharp.toBuffer();

    // 1. Handle Background Removal with Redundancy Chain
    let transparentProductBuffer = null;
    if (bgRemove) {
      // Prefer fully local model inference. No image leaves this machine.
      try {
        transparentProductBuffer = await localModelBgRemove(fileBuffer);
      } catch (err) {
        utils.logAudit("WARN", `Local AI background removal failed: ${err.message}. Falling back...`);
      }

      // Optional hosted fallbacks for users who already configured them.
      if (!transparentProductBuffer && process.env.PHOTOROOM_API_KEY) {
        try {
          transparentProductBuffer = await photoroomBgRemove(fileBuffer, process.env.PHOTOROOM_API_KEY);
        } catch (err) {
          utils.logAudit("WARN", `Photoroom API background removal failed: ${err.message}. Falling back...`);
        }
      }
      
      // Try Remove.bg fallback
      if (!transparentProductBuffer && process.env.REMOVE_BG_API_KEY) {
        try {
          transparentProductBuffer = await removeBgApiRemove(fileBuffer, process.env.REMOVE_BG_API_KEY);
        } catch (err) {
          utils.logAudit("WARN", `Remove.bg API background removal failed: ${err.message}. Falling back...`);
        }
      }

      // Try Local Chroma-Key thresholding fallback
      if (!transparentProductBuffer) {
        try {
          transparentProductBuffer = await localChromaKeyBgRemove(fileBuffer, 35, 15);
        } catch (err) {
          utils.logAudit("ERROR", `Chroma-Key background removal failed: ${err.message}`);
        }
      }
    }

    // Load active working image
    let productSharp = sharp(transparentProductBuffer || fileBuffer);

    // 2. Contrast and Color leveling
    if (enableColorCorrection) {
      const br = options.brightness !== undefined ? parseFloat(options.brightness) : 1.03;
      const sat = options.saturation !== undefined ? parseFloat(options.saturation) : 1.05;
      productSharp = productSharp.normalise().modulate({
        brightness: br,
        saturation: sat
      });
    }

    // 3. Smart Content Bounding-Box Detection & Auto-Framing
    // If background removed, crop tight to the subject and pad it safely to 85% of canvas size.
    if (bgRemove || transparentProductBuffer) {
      try {
        productSharp = productSharp.trim();
      } catch (e) {
        utils.logAudit("WARN", `Could not trim transparency borders: ${e.message}`);
      }
    }

    // Resize subject content to fill 85% of the target canvas size
    const frameSize = Math.round(canvasSize * 0.85);
    productSharp = productSharp.resize({
      width: frameSize,
      height: frameSize,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });

    const productPngBuffer = await productSharp.png().toBuffer();

    // 4. Construct Studio Canvas Background
    let finalCanvas;
    if (bgStyle === 'gradient') {
      const gradientSvg = Buffer.from(`
        <svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="g" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#f8f9fa"/>
              <stop offset="100%" stop-color="#e9ecef"/>
            </linearGradient>
          </defs>
          <rect width="${canvasSize}" height="${canvasSize}" fill="url(#g)"/>
        </svg>
      `.trim());
      finalCanvas = sharp(gradientSvg);
    } else if (bgStyle === 'transparent') {
      finalCanvas = sharp({
        create: {
          width: canvasSize,
          height: canvasSize,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      });
    } else {
      // Solid White
      finalCanvas = sharp({
        create: {
          width: canvasSize,
          height: canvasSize,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      });
    }

    // Composite centered subject onto final canvas
    const offset = Math.round((canvasSize - frameSize) / 2);
    finalCanvas = finalCanvas.composite([
      {
        input: productPngBuffer,
        top: offset,
        left: offset,
        blend: 'over'
      }
    ]);

    // Force rendering composite to raw buffer before applying watermarks to prevent pipeline ordering errors
    let finalBuffer = await finalCanvas.png().toBuffer();
    let finalSharpImg = sharp(finalBuffer);

    // 5. Apply dynamic watermark overlay
    if (enableWatermark) {
      finalSharpImg = applyWatermarkOverlay(finalSharpImg, activeWatermark, watermarkPosition, canvasSize);
    }

    // 6. Convert to high-quality progressive JPEG (or png if transparency is requested)
    if (bgStyle === 'transparent') {
      return await finalSharpImg.png().toBuffer();
    }

    return await finalSharpImg
      .jpeg({
        quality: 92,
        progressive: true,
        mozjpeg: true
      })
      .toBuffer();

  } catch (err) {
    throw new ImagePipelineError(`Failed to process image: ${err.message}`, err);
  }
}

/**
 * Public entrypoint to process an image from any source.
 * @param {string} source - Local file path or Remote HTTP URL.
 * @param {object} [options] - Optimization parameters.
 * @returns {Promise<{outputPath: string, metadata: object}>}
 */
async function processImageSource(source, options = {}) {
  let localPath = source;
  let isTempDownload = false;

  const imageDownloader = require('./imageDownloader');

  try {
    if (/^https?:\/\//i.test(source)) {
      localPath = await imageDownloader.downloadAndCacheImage(source);
      isTempDownload = true;
    }

    const resolvedIn = path.resolve(localPath);
    if (!fs.existsSync(resolvedIn)) {
      throw new ImagePipelineError(`Source image file does not exist: ${resolvedIn}`);
    }

    const optimizedBuffer = await spruceImageBuffer(resolvedIn, options);
    
    const processedDir = path.join(config.uploadTempDir, 'processed');
    if (!fs.existsSync(processedDir)) {
      fs.mkdirSync(processedDir, { recursive: true });
    }

    const ext = options.bgStyle === 'transparent' ? 'png' : 'jpg';
    const filename = `spruced-${Date.now()}-${path.basename(resolvedIn).replace(/\.[^.]+$/, '')}.${ext}`;
    const outputPath = path.join(processedDir, filename);
    
    fs.writeFileSync(outputPath, optimizedBuffer);
    utils.logAudit("INFO", `Optimized image saved to: ${outputPath}`);

    const finalMeta = await sharp(outputPath).metadata();

    return {
      outputPath,
      metadata: {
        width: finalMeta.width,
        height: finalMeta.height,
        size: optimizedBuffer.length,
        format: finalMeta.format
      }
    };
  } finally {
    // Safely remove temporary downloaded files ONLY if they are not in the downloader cache
    // The imageDownloader handles caches by hashing, but let's keep cache files alive for deduplication hit
    // So we don't unlink them here if they are in config.uploadTempDir/processed or active downloader cache path
  }
}

module.exports = {
  processImageSource,
  spruceImageBuffer,
  localModelBgRemove,
  localChromaKeyBgRemove,
  applyWatermarkOverlay,
  ImagePipelineError
};
