const fs = require('fs');
const path = require('path');
const config = require('../config');
const utils = require('../utils');
const ebayClient = require('../ebayClient');

/**
 * Uploads file buffer to primary temporary image host (tmpfiles.org).
 * @param {string} filename - Filename string.
 * @param {Buffer} fileBuffer - Image buffer.
 * @param {string} boundary - Multipart boundary string.
 * @returns {Promise<string>} Uploaded file URL.
 */
async function uploadToTmpFiles(filename, fileBuffer, boundary) {
  const header = `--${boundary}\nContent-Disposition: form-data; name="file"; filename="${filename}"\nContent-Type: image/jpeg\n\n`;
  const footer = `\n--${boundary}--\n`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8')
  ]);

  const response = await ebayClient.fetchWithRetry("https://tmpfiles.org/api/v1/upload", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyBuffer
  });

  const resData = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(resData));
  return resData.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
}

/**
 * Uploads file buffer to fallback temporary image host (file.io).
 * @param {string} filename - Filename string.
 * @param {Buffer} fileBuffer - Image buffer.
 * @param {string} boundary - Multipart boundary string.
 * @returns {Promise<string>} Uploaded file URL.
 */
async function uploadToFileIo(filename, fileBuffer, boundary) {
  const header = `--${boundary}\nContent-Disposition: form-data; name="file"; filename="${filename}"\nContent-Type: image/jpeg\n\n`;
  const footer = `\n--${boundary}--\n`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(header, 'utf8'),
    fileBuffer,
    Buffer.from(footer, 'utf8')
  ]);

  const response = await ebayClient.fetchWithRetry("https://file.io/?expires=1d", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyBuffer
  });

  const resData = await response.json();
  if (!response.ok || !resData.success) throw new Error(JSON.stringify(resData));
  return resData.link;
}

/**
 * Uploads local image to temp image host, using fallback if primary fails.
 * @param {string} imagePath - Absolute path to local image.
 * @returns {Promise<string>} File URL.
 */
async function uploadImage(imagePath) {
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
  const filename = path.basename(imagePath);
  const fileBuffer = fs.readFileSync(imagePath);

  try {
    return await uploadToTmpFiles(filename, fileBuffer, boundary);
  } catch (err) {
    utils.logAudit("WARN", `Primary image host failed for ${filename}: ${err.message}. Trying file.io fallback...`);
    try {
      return await uploadToFileIo(filename, fileBuffer, boundary);
    } catch (err2) {
      utils.logAudit("ERROR", `All upload options failed.`);
      throw new Error(`All temporary image hosts failed to upload ${filename}.\nDetails:\n[Primary]: ${err.message}\n[Fallback]: ${err2.message}`);
    }
  }
}

/**
 * Downloads a remote image, optimizes it natively (squaring/centering), and uploads it.
 * @param {string} url - Remote stock photo URL.
 * @returns {Promise<string>} New optimized remote image URL.
 */
async function downloadAndOptimizeStockPhoto(url) {
  utils.logAudit("INFO", `Downloading and optimizing remote stock photo: ${url}`);
  const tempFilename = `stock-download-${Date.now()}-${Math.round(Math.random() * 1000)}.jpg`;
  const tempFilePath = path.join(config.uploadTempDir, tempFilename);
  const optFilePath = path.join(config.uploadTempDir, `opt-${tempFilename}`);

  try {
    const res = await ebayClient.fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`Failed to download stock photo, status ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(tempFilePath, buffer);

    // Validate image format/signature
    utils.verifyImageFile(tempFilePath);

    // Optimize
    await utils.optimizeImageNative(tempFilePath, optFilePath, 1600);

    // Upload optimized
    const uploadedUrl = await uploadImage(optFilePath);

    // Cleanup
    try { fs.unlinkSync(tempFilePath); } catch (e) {}
    try { fs.unlinkSync(optFilePath); } catch (e) {}

    return uploadedUrl;
  } catch (err) {
    utils.logAudit("WARN", `Failed to download/optimize stock photo: ${err.message}. Using original URL.`);
    // Cleanup on error
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
    try { if (fs.existsSync(optFilePath)) fs.unlinkSync(optFilePath); } catch (e) {}
    return url;
  }
}

/**
 * Converts a URL (local /uploads/ or external HTTP) into a permanent eBay Picture Services (EPS) URL.
 * @param {string} urlOrPath - The image URL or local upload path reference.
 * @returns {Promise<string>} Permanent EPS URL or fallback to original.
 */
async function convertImageToEPS(urlOrPath) {
  if (typeof urlOrPath !== 'string') return urlOrPath;

  // Case 1: Local upload URL
  if (urlOrPath.startsWith('/uploads/')) {
    try {
      const localPath = utils.resolveUploadsPath(urlOrPath);
      if (fs.existsSync(localPath)) {
        return await ebayClient.uploadImageToEPS(localPath);
      }
    } catch (err) {
      utils.logAudit("WARN", `Failed to upload local image to EPS: ${err.message}. Using original URL.`);
    }
    return urlOrPath;
  }

  // Case 2: External HTTP URL (needs download, optimization, and then EPS upload)
  if (urlOrPath.startsWith('http')) {
    const tempFilename = `eps-download-${Date.now()}-${Math.round(Math.random() * 1000)}.jpg`;
    const tempFilePath = path.join(config.uploadTempDir, tempFilename);
    const optFilePath = path.join(config.uploadTempDir, `opt-${tempFilename}`);

    try {
      const res = await ebayClient.fetchWithRetry(urlOrPath);
      if (!res.ok) {
        throw new Error(`Failed to download remote photo, status ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(tempFilePath, buffer);

      utils.verifyImageFile(tempFilePath);
      await utils.optimizeImageNative(tempFilePath, optFilePath, 1600);

      const epsUrl = await ebayClient.uploadImageToEPS(optFilePath);

      try { fs.unlinkSync(tempFilePath); } catch (e) {}
      try { fs.unlinkSync(optFilePath); } catch (e) {}

      return epsUrl;
    } catch (err) {
      utils.logAudit("WARN", `Failed to process external photo for EPS upload: ${err.message}. Using original URL.`);
      try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
      try { if (fs.existsSync(optFilePath)) fs.unlinkSync(optFilePath); } catch (e) {}
      return urlOrPath;
    }
  }

  return urlOrPath;
}

/**
 * Uploads multiple images with a concurrency limit.
 * @param {string[]} imagePaths - Paths of images to upload.
 * @param {number} [limit=2] - Max concurrent uploads.
 * @returns {Promise<string[]>} Uploaded URLs.
 */
async function uploadImagesConcurrently(imagePaths, limit = 2) {
  const results = new Array(imagePaths.length);
  let index = 0;

  async function worker() {
    while (index < imagePaths.length) {
      const myIndex = index++;
      const imgPath = imagePaths[myIndex];
      results[myIndex] = await uploadImage(imgPath);
    }
  }

  const workers = [];
  const numWorkers = Math.min(limit, imagePaths.length);
  for (let i = 0; i < numWorkers; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

module.exports = {
  uploadToTmpFiles,
  uploadToFileIo,
  uploadImage,
  downloadAndOptimizeStockPhoto,
  convertImageToEPS,
  uploadImagesConcurrently
};
