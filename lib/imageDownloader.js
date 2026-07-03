/**
 * @file lib/imageDownloader.js
 * @description Ingestion layer for downloading image URLs and scraping retail listing pages concurrently.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const utils = require('../utils');
const config = require('../config');

// In-memory MD5 cache to prevent duplicate processing within a listing session
const md5Cache = new Map(); // MD5 Hash -> Local Filepath

/**
 * Parses and upgrades low-res image URLs to full-res equivalents.
 * @param {string} url - Input image URL.
 * @returns {string} Upgraded image URL.
 */
function upgradeImageUrl(url) {
  try {
    let upgraded = url.trim();

    // 1. Amazon upgrade:
    // Pattern matches extension modifiers like ._AC_SR150,300_ or ._SL150_
    // Example: https://images-na.ssl-images-amazon.com/images/I/71xyz._AC_SR120,120_.jpg -> ...71xyz.jpg
    if (upgraded.includes('amazon.com') || upgraded.includes('media-amazon.com')) {
      upgraded = upgraded.replace(/\._AC_[^/]*\./i, '.');
      upgraded = upgraded.replace(/\._SL\d+_\./i, '.');
      upgraded = upgraded.replace(/\._SR\d+(x\d+)?_\./i, '.');
      upgraded = upgraded.replace(/\._SX\d+_\./i, '.');
      upgraded = upgraded.replace(/\._SY\d+_\./i, '.');
    }

    // 2. eBay upgrade:
    // Pattern matches s-l500.jpg, s-l140.jpg, etc.
    // Example: https://i.ebayimg.com/images/g/xyz/s-l500.jpg -> .../s-l1600.jpg
    if (upgraded.includes('ebayimg.com')) {
      upgraded = upgraded.replace(/\/s-l\d+\.(jpg|png|jpeg|webp)/i, '/s-l1600.$1');
    }

    // 3. Shopify upgrade:
    // Pattern matches _100x100, _large, _compact, etc.
    // Example: https://cdn.shopify.com/s/files/.../img_large.jpg -> .../img.jpg
    if (upgraded.includes('cdn.shopify.com')) {
      upgraded = upgraded.replace(/_(small|medium|large|compact|grande|1024x1024|2048x2048|\d+x\d*|\d*x\d+)\.(jpg|png|webp|gif|jpeg)/i, '.$2');
    }

    return upgraded;
  } catch (err) {
    return url;
  }
}

/**
 * Extracts product images from retail listing pages (Amazon, eBay, Etsy, Shopify)
 * @param {string} pageUrl - Retail page URL
 * @returns {Promise<string[]>} List of image URLs found
 */
async function scrapeImagesFromPage(pageUrl) {
  utils.validateRemoteImageUrl(pageUrl);
  utils.logAudit("INFO", `Scraping product page for images: ${pageUrl}`);
  
  // Custom headers to bypass simple bot checks
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // Shopify Check: If it looks like a Shopify product page, try appending `.js` to fetch clean JSON
  if (/\/products\/[^/?#]+/.test(pageUrl)) {
    try {
      const urlObj = new URL(pageUrl);
      urlObj.pathname = urlObj.pathname.replace(/\/$/, '') + '.js';
      utils.logAudit("INFO", `Attempting Shopify JSON fetch: ${urlObj.toString()}`);
      
      const res = await axios.get(urlObj.toString(), { 
        headers, 
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024,
        maxBodyLength: 5 * 1024 * 1024
      });
      if (res.data && Array.isArray(res.data.images)) {
        return res.data.images.map(img => img.startsWith('//') ? `https:${img}` : img);
      }
    } catch (err) {
      utils.logAudit("WARN", `Shopify JSON fetch failed, falling back to HTML parsing: ${err.message}`);
    }
  }

  try {
    const res = await axios.get(pageUrl, { 
      headers, 
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 5 * 1024 * 1024
    });
    const html = res.data;
    const imageUrls = new Set();

    // 1. Amazon Regex parsing
    if (pageUrl.includes('amazon.com')) {
      const colorImagesRegex = /'colorImages':\s*({[\s\S]*?}),\s*'colorToAsin'/i;
      const match = html.match(colorImagesRegex);
      if (match) {
        try {
          const parsed = JSON.parse(match[1].replace(/'/g, '"'));
          for (const color in parsed) {
            const list = parsed[color];
            if (Array.isArray(list)) {
              list.forEach(img => {
                const highRes = img.hiRes || img.large || img.main?.['0'];
                if (highRes) imageUrls.add(highRes);
              });
            }
          }
        } catch (e) {}
      }

      const landingImageRegex = /"large":"(https:\/\/images-na\.ssl-images-amazon\.com\/images\/I\/[^"]+)"/g;
      let m;
      while ((m = landingImageRegex.exec(html)) !== null) {
        imageUrls.add(m[1]);
      }
      
      const hiResRegex = /"hiRes":"(https:\/\/[^"]+)"/g;
      while ((m = hiResRegex.exec(html)) !== null) {
        imageUrls.add(m[1]);
      }
    }

    // 2. eBay Regex parsing
    else if (pageUrl.includes('ebay.com')) {
      const ebayImgRegex = /(https:\/\/i\.ebayimg\.com\/images\/g\/[^/]+\/s-l1600\.(jpg|png|jpeg))/gi;
      let m;
      while ((m = ebayImgRegex.exec(html)) !== null) {
        imageUrls.add(m[1]);
      }

      const ebayImgFallbackRegex = /(https:\/\/i\.ebayimg\.com\/images\/g\/[^/]+\/s-l\d+\.(jpg|png|jpeg))/gi;
      while ((m = ebayImgFallbackRegex.exec(html)) !== null) {
        imageUrls.add(upgradeImageUrl(m[1]));
      }
    }

    // 3. Etsy Regex parsing
    else if (pageUrl.includes('etsy.com')) {
      const etsyImgRegex = /(https:\/\/i\.etsystatic\.com\/[^"]+\/r\/il\/[^"]+_\d+x\d+_[^"]+\.(jpg|png|jpeg))/gi;
      let m;
      while ((m = etsyImgRegex.exec(html)) !== null) {
        const upgraded = m[1].replace(/_\d+x\d+_/i, '_fullxfull_');
        imageUrls.add(upgraded);
      }
      
      const ogImgRegex = /<meta\s+property="og:image"\s+content="([^"]+)"/i;
      const ogMatch = html.match(ogImgRegex);
      if (ogMatch) {
        imageUrls.add(ogMatch[1]);
      }
    }

    // 4. Generic/Social og:image scraper fallback
    if (imageUrls.size === 0) {
      const ogImgRegex = /<meta\s+property="og:image"\s+content="([^"]+)"/gi;
      let m;
      while ((m = ogImgRegex.exec(html)) !== null) {
        imageUrls.add(m[1]);
      }
    }

    const results = Array.from(imageUrls).map(upgradeImageUrl);
    utils.logAudit("INFO", `Scraped ${results.length} images from page: ${pageUrl}`);
    return results;
  } catch (err) {
    utils.logAudit("ERROR", `Failed to scrape listing page (${pageUrl}): ${err.message}`);
    return [];
  }
}

/**
 * Downloads a single URL with retries, hashing it to prevent duplicates.
 * @param {string} url - Target URL to download.
 * @returns {Promise<string>} Path to local downloaded file.
 */
async function downloadAndCacheImage(url) {
  const safeUrl = utils.validateRemoteImageUrl(url);
  const upgradedUrl = upgradeImageUrl(safeUrl);
  
  let retries = 3;
  let response;
  
  while (retries > 0) {
    try {
      response = await axios({
        method: 'GET',
        url: upgradedUrl,
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 15 * 1024 * 1024,
        maxBodyLength: 15 * 1024 * 1024,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
        validateStatus: (status) => status >= 200 && status < 400
      });
      break;
    } catch (err) {
      retries--;
      if (retries === 0) {
        throw new Error(`Failed to download image after 3 attempts: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const contentType = (response.headers['content-type'] || '').toLowerCase();
  if (contentType && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) {
    throw new Error(`URL did not return an image (content-type: ${contentType || 'unknown'})`);
  }
  let ext = '.jpg';
  if (contentType.includes('png')) ext = '.png';
  else if (contentType.includes('webp')) ext = '.webp';
  else if (contentType.includes('heic')) ext = '.heic';
  else if (upgradedUrl.toLowerCase().endsWith('.heic')) ext = '.heic';
  else if (upgradedUrl.toLowerCase().endsWith('.webp')) ext = '.webp';

  const buffer = Buffer.from(response.data || []);
  if (buffer.length === 0) {
    throw new Error('Downloaded image is empty');
  }
  if (buffer.length > 12 * 1024 * 1024) {
    throw new Error('Downloaded image exceeds 12MB limit');
  }

  const hash = crypto.createHash('md5').update(buffer).digest('hex');

  if (md5Cache.has(hash)) {
    const cachedPath = md5Cache.get(hash);
    if (fs.existsSync(cachedPath)) {
      utils.logAudit("INFO", `Deduplication hit. Returning cached file for MD5: ${hash}`);
      return cachedPath;
    }
  }

  const filename = `download-${Date.now()}-${Math.round(Math.random() * 1000)}${ext}`;
  const tempFilePath = path.join(config.uploadTempDir, filename);
  fs.writeFileSync(tempFilePath, buffer);

  try {
    utils.verifyImageFile(tempFilePath);
  } catch (verifyErr) {
    try { fs.unlinkSync(tempFilePath); } catch (e) {}
    throw new Error(`Downloaded file is not a valid image: ${verifyErr.message}`);
  }
  
  md5Cache.set(hash, tempFilePath);
  utils.logAudit("INFO", `Saved download to: ${tempFilePath} (MD5: ${hash})`);
  return tempFilePath;
}

/**
 * Downloads a list of URLs concurrently, limited to max concurrency.
 * @param {string[]} urls - List of image/page URLs.
 * @param {object} [options] - Ingestion options.
 * @param {number} [concurrency=3] - Maximum parallel downloads.
 * @returns {Promise<string[]>} Local temporary filepaths downloaded.
 */
async function downloadUrlsConcurrently(urls, options = {}, concurrency = 3) {
  const allUrls = [];

  for (const url of urls) {
    if (url.includes('/dp/') || url.includes('/itm/') || url.includes('etsy.com/listing/') || url.includes('/products/')) {
      const scraped = await scrapeImagesFromPage(url);
      if (scraped.length > 0) {
        allUrls.push(...scraped);
      } else {
        allUrls.push(url);
      }
    } else {
      allUrls.push(url);
    }
  }

  const uniqueUrls = Array.from(new Set(allUrls));
  const results = new Array(uniqueUrls.length);
  let activeIndex = 0;

  async function worker() {
    while (activeIndex < uniqueUrls.length) {
      const idx = activeIndex++;
      const url = uniqueUrls[idx];
      try {
        results[idx] = await downloadAndCacheImage(url);
      } catch (err) {
        utils.logAudit("WARN", `Failed downloading URL: ${url}. Error: ${err.message}`);
        results[idx] = null;
      }
    }
  }

  const workers = [];
  const numWorkers = Math.min(concurrency, uniqueUrls.length);
  for (let i = 0; i < numWorkers; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results.filter(filepath => filepath !== null);
}

module.exports = {
  upgradeImageUrl,
  scrapeImagesFromPage,
  downloadAndCacheImage,
  downloadUrlsConcurrently,
  clearDeduplicationCache: () => md5Cache.clear()
};
