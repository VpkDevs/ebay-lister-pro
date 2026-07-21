/**
 * @file utils.js
 * @description General utility operations including file handling, binary checks, launchers and formatting with JSDoc typing.
 */

const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const config = require('./config');
const { AsyncLocalStorage } = require('node:async_hooks');
const asyncLocalStorage = new AsyncLocalStorage();
const logger = require('./lib/logger');
const db = require('./lib/db');

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts secrets (Gemini API keys, eBay refresh tokens, Stripe secrets, etc.) from string outputs.
 * @param {string} message - Message to scrub.
 * @returns {string} Cleaned string.
 */
function sanitizeLog(message) {
  if (typeof message !== 'string') return message;
  let clean = message;
  
  const secrets = [
    { value: config.getGEMINI_API_KEY(), label: '[REDACTED_GEMINI_KEY]' },
    { value: config.getEBAY_CLIENT_SECRET(), label: '[REDACTED_CLIENT_SECRET]' },
    { value: config.getEBAY_REFRESH_TOKEN(), label: '[REDACTED_REFRESH_TOKEN]' },
    { value: config.getSTRIPE_SECRET_KEY(), label: '[REDACTED_STRIPE_SECRET_KEY]' },
    { value: config.getSTRIPE_WEBHOOK_SECRET(), label: '[REDACTED_STRIPE_WEBHOOK_SECRET]' },
    { value: config.getWOOCOMMERCE_KEY(), label: '[REDACTED_WOOCOMMERCE_KEY]' },
    { value: config.getWOOCOMMERCE_SECRET(), label: '[REDACTED_WOOCOMMERCE_SECRET]' },
    { value: config.getETSY_ACCESS_TOKEN(), label: '[REDACTED_ETSY_ACCESS_TOKEN]' }
  ];

  for (const secret of secrets) {
    if (secret.value && typeof secret.value === 'string' && secret.value.trim().length > 0) {
      const escaped = escapeRegExp(secret.value.trim());
      clean = clean.replace(new RegExp(escaped, 'g'), secret.label);
    }
  }

  // Scrub Shopify tokens via pattern matching
  clean = clean.replace(/shpat_[a-zA-Z0-9]{32}/g, '[REDACTED_SHOPIFY_TOKEN]');
  // Scrub WooCommerce consumer credentials via pattern matching
  clean = clean.replace(/ck_[a-zA-Z0-9]{40}/g, '[REDACTED_WOOCOMMERCE_KEY]');
  clean = clean.replace(/cs_[a-zA-Z0-9]{40}/g, '[REDACTED_WOOCOMMERCE_SECRET]');
  // Scrub Basic Auth headers
  clean = clean.replace(/Basic\s+[a-zA-Z0-9+/=]+/gi, 'Basic [REDACTED_AUTH_HEADER]');
  // Scrub Bearer tokens
  clean = clean.replace(/Bearer\s+[a-zA-Z0-9\-._~+/=]+/gi, 'Bearer [REDACTED_BEARER_TOKEN]');

  return clean;
}

/**
 * Appends an audit message to the log file.
 * @param {string} level - Log level (e.g. INFO, WARN, ERROR, FATAL).
 * @param {string} message - Message body.
 * @param {object|null} [data] - Optional related object data.
 * @returns {void}
 */
function logAudit(level, message, data = null, traceId = null) {
  try {
    const store = asyncLocalStorage.getStore();
    const activeTraceId = traceId || (store ? store.traceId : null);
    const cleanLevel = String(level || 'INFO').toUpperCase();
    
    let pinoMethod = 'info';
    if (cleanLevel === 'WARN') pinoMethod = 'warn';
    else if (cleanLevel === 'ERROR') pinoMethod = 'error';
    else if (cleanLevel === 'FATAL') pinoMethod = 'fatal';
    else if (cleanLevel === 'DEBUG') pinoMethod = 'debug';

    logger[pinoMethod]({ traceId: activeTraceId, data }, message);
  } catch (e) {}
}

/**
 * Safely resolves and cleans a file path, ensuring it doesn't traverse outside process limits.
 * @param {string} targetPath - Relative or absolute path.
 * @returns {string} Resolved absolute path.
 * @throws {Error} if path traversal attempts are detected.
 */
function safeResolvePath(targetPath) {
  const resolved = path.resolve(targetPath);
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(cwd, resolved);
  
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Directory traversal attempt detected: ${targetPath}`);
  }
  return resolved;
}

const MAX_LISTING_IMAGES = 24;
const BLOCKED_URL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * Returns true when a hostname resolves to a private or loopback address.
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_URL_HOSTS.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;

  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const parts = ipv4Match.slice(1).map(Number);
    if (parts.some(p => p > 255)) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  return false;
}

/**
 * Validates a remote HTTP(S) URL for image ingestion (blocks SSRF targets).
 * @param {string} urlString
 * @returns {string} Normalized URL
 */
function validateRemoteImageUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) {
    throw new Error('URL must be a non-empty string');
  }

  let parsed;
  try {
    parsed = new URL(urlString.trim());
  } catch {
    throw new Error(`Invalid URL format: ${urlString.slice(0, 120)}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use http or https');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(`Blocked URL target: ${parsed.hostname}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  return parsed.href;
}

/**
 * Maps a served /uploads/ URL to a safe local filesystem path.
 * @param {string} uploadUrlPath
 * @returns {string}
 */
function resolveUploadsPath(uploadUrlPath) {
  if (typeof uploadUrlPath !== 'string' || !uploadUrlPath.startsWith('/uploads/')) {
    throw new Error('Invalid uploads path');
  }

  const relative = uploadUrlPath.replace(/^\/uploads\//, '').replace(/\\/g, '/');
  if (!relative || relative.includes('..')) {
    throw new Error('Path traversal detected in uploads path');
  }

  const fullPath = path.join(config.uploadTempDir, relative);
  const resolved = safeResolvePath(fullPath);
  const uploadRoot = safeResolvePath(config.uploadTempDir);
  const relToUpload = path.relative(uploadRoot, resolved);
  if (relToUpload.startsWith('..') || path.isAbsolute(relToUpload)) {
    throw new Error('Upload path escapes upload directory');
  }
  return resolved;
}

/**
 * Writes data atomically to a JSON file with lockfile concurrency control to prevent corruption.
 * @param {string} filePath - Absolute path to file.
 * @param {any} data - JS payload.
 * @returns {void}
 */
function writeJsonFileSecure(filePath, data) {
  const resolved = safeResolvePath(filePath);

  // 1. Write to actual file on disk with locks/backups (keeps filesystem compatibility for tests)
  const tempWritePath = `${resolved}.tmp`;
  const backupPath = `${resolved}.bak`;
  const lockPath = `${resolved}.lock`;
  
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    try {
      const lockFd = fs.openSync(lockPath, 'wx');
      fs.closeSync(lockFd);
      break;
    } catch (lockErr) {
      attempts++;
      if (attempts >= maxAttempts) {
        logAudit("ERROR", `Database Lock timeout for ${resolved}. Overwriting lock to avoid data loss...`);
        try { fs.unlinkSync(lockPath); } catch (e) {}
        break;
      }
      const end = Date.now() + 15;
      while (Date.now() < end) {}
    }
  }

  try {
    fs.writeFileSync(tempWritePath, JSON.stringify(data, null, 2), 'utf8');
    if (fs.existsSync(resolved)) {
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      fs.renameSync(resolved, backupPath);
    }
    fs.renameSync(tempWritePath, resolved);
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  } catch (err) {
    logAudit("ERROR", `Secure JSON Write failed for ${resolved}: ${err.message}`);
    if (fs.existsSync(tempWritePath)) {
      try { fs.unlinkSync(tempWritePath); } catch (e) {}
    }
    throw err;
  } finally {
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch (e) {}
  }

  // 2. Synchronize to SQLite Database for production-grade speed and reliability
  if (resolved === safeResolvePath(config.dlqPath)) {
    db.db.transaction(() => {
      db.dlq.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.dlq.save(entry);
        }
      }
    })();
  } else if (resolved === safeResolvePath(config.historyPath)) {
    db.db.transaction(() => {
      db.listings.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.listings.save(entry);
        }
      }
    })();
  } else if (resolved === safeResolvePath(path.join(process.cwd(), 'data', 'templates.json'))) {
    db.db.transaction(() => {
      db.db.prepare('DELETE FROM templates').run();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.templates.save(entry);
        }
      }
    })();
  }
}

/**
 * Reads a JSON file, checking lock state and falling back to backup if primary is corrupted.
 * Synchronizes SQLite database state to match.
 * @param {string} filePath - Path to file.
 * @param {any} [defaultData] - Default value if both file and backup fail.
 * @returns {any} JS parsed data.
 */
function readJsonFileSecure(filePath, defaultData = []) {
  const resolved = safeResolvePath(filePath);
  const backupPath = `${resolved}.bak`;
  const lockPath = `${resolved}.lock`;
  
  let attempts = 0;
  const maxAttempts = 10;
  
  while (fs.existsSync(lockPath) && attempts < maxAttempts) {
    attempts++;
    const end = Date.now() + 10;
    while (Date.now() < end) {}
  }

  let fileContent = null;
  let hasParsed = false;
  let data = defaultData;

  try {
    if (fs.existsSync(resolved)) {
      try {
        fileContent = fs.readFileSync(resolved, 'utf8');
        data = JSON.parse(fileContent);
        hasParsed = true;
      } catch (parseErr) {
        logAudit("WARN", `Primary database file corrupt: ${parseErr.message}. Recovering from backup: ${backupPath}`);
        if (fs.existsSync(backupPath)) {
          fileContent = fs.readFileSync(backupPath, 'utf8');
          data = JSON.parse(fileContent);
          fs.copyFileSync(backupPath, resolved);
          hasParsed = true;
        } else {
          throw parseErr;
        }
      }
    } else if (fs.existsSync(backupPath)) {
      logAudit("WARN", `Primary database file missing. Recovering from backup: ${backupPath}`);
      fileContent = fs.readFileSync(backupPath, 'utf8');
      data = JSON.parse(fileContent);
      fs.copyFileSync(backupPath, resolved);
      hasParsed = true;
    }
  } catch (err) {
    logAudit("ERROR", `Secure JSON Read failed for ${resolved}: ${err.message}. Triggering self-healing...`);
    if (fs.existsSync(backupPath)) {
      try {
        fileContent = fs.readFileSync(backupPath, 'utf8');
        data = JSON.parse(fileContent);
        try { fs.copyFileSync(backupPath, resolved); } catch (e) {}
        hasParsed = true;
      } catch (e) {}
    }
    if (!hasParsed) {
      try {
        logAudit("WARN", `Both primary and backup database corrupted for ${resolved}. Re-initializing with default structure.`);
        fs.writeFileSync(resolved, JSON.stringify(defaultData, null, 2), 'utf8');
        fs.writeFileSync(backupPath, JSON.stringify(defaultData, null, 2), 'utf8');
      } catch (e) {
        logAudit("ERROR", `Failed to self-heal database file ${resolved}: ${e.message}`);
      }
    }
  }

  // Sync database with the loaded/recovered data (maintains SQLite storage consistency)
  // Return disk-parsed data to preserve exact object shape (no DB default columns added).
  if (resolved === safeResolvePath(config.dlqPath)) {
    db.db.transaction(() => {
      db.dlq.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.dlq.save(entry);
        }
      }
    })();
    return data;
  }

  if (resolved === safeResolvePath(config.historyPath)) {
    db.db.transaction(() => {
      db.listings.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.listings.save(entry);
        }
      }
    })();
    return data;
  }

  if (resolved === safeResolvePath(path.join(process.cwd(), 'data', 'templates.json'))) {
    db.db.transaction(() => {
      db.templates.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.templates.save(entry);
        }
      }
    })();
    return data;
  }

  return data;
}

/**
 * Asynchronously writes data atomically to a JSON file with non-blocking lockfile concurrency control.
 * Synchronizes SQLite database state to match.
 * @param {string} filePath - Absolute path to file.
 * @param {any} data - JS payload.
 * @returns {Promise<void>}
 */
async function writeJsonFileSecureAsync(filePath, data) {
  const resolved = safeResolvePath(filePath);

  // 1. Async write to disk
  const tempWritePath = `${resolved}.tmp`;
  const backupPath = `${resolved}.bak`;
  const lockPath = `${resolved}.lock`;
  
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    try {
      const lockFh = await fs.promises.open(lockPath, 'wx');
      await lockFh.close();
      if (attempts > 0) {
        logAudit("INFO", `Async Database Lock acquired for ${resolved} after ${attempts} retries.`);
      }
      break;
    } catch (lockErr) {
      attempts++;
      if (attempts >= maxAttempts) {
        logAudit("ERROR", `Async Database Lock timeout for ${resolved} after ${attempts} attempts. Overwriting lock to avoid data loss...`);
        try { await fs.promises.unlink(lockPath); } catch (e) {}
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  try {
    await fs.promises.writeFile(tempWritePath, JSON.stringify(data, null, 2), 'utf8');
    try {
      await fs.promises.access(resolved);
      try { await fs.promises.unlink(backupPath); } catch (e) {}
      await fs.promises.rename(resolved, backupPath);
    } catch (e) {}
    await fs.promises.rename(tempWritePath, resolved);
    try { await fs.promises.unlink(backupPath); } catch (e) {}
  } catch (err) {
    logAudit("ERROR", `Secure Async JSON Write failed for ${resolved}: ${err.message}`);
    try { await fs.promises.unlink(tempWritePath); } catch (e) {}
    throw err;
  } finally {
    try { await fs.promises.unlink(lockPath); } catch (e) {}
  }

  // 2. Sync to SQLite
  if (resolved === safeResolvePath(config.dlqPath)) {
    db.db.transaction(() => {
      db.dlq.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.dlq.save(entry);
        }
      }
    })();
  } else if (resolved === safeResolvePath(config.historyPath)) {
    db.db.transaction(() => {
      db.listings.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.listings.save(entry);
        }
      }
    })();
  } else if (resolved === safeResolvePath(path.join(process.cwd(), 'data', 'templates.json'))) {
    db.db.transaction(() => {
      db.db.prepare('DELETE FROM templates').run();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.templates.save(entry);
        }
      }
    })();
  }
}

/**
 * Asynchronously reads a JSON file, checking lock state non-blockingly and falling back to backup.
 * Synchronizes SQLite database state to match.
 * @param {string} filePath - Path to file.
 * @param {any} [defaultData] - Default value.
 * @returns {Promise<any>} JS parsed data.
 */
async function readJsonFileSecureAsync(filePath, defaultData = []) {
  const resolved = safeResolvePath(filePath);
  const backupPath = `${resolved}.bak`;
  const lockPath = `${resolved}.lock`;
  
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    try {
      await fs.promises.access(lockPath);
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (e) {
      break;
    }
  }

  let fileContent = null;
  let hasParsed = false;
  let data = defaultData;

  try {
    let hasPrimary = true;
    try { await fs.promises.access(resolved); } catch (e) { hasPrimary = false; }

    if (hasPrimary) {
      try {
        fileContent = await fs.promises.readFile(resolved, 'utf8');
        data = JSON.parse(fileContent);
        hasParsed = true;
      } catch (parseErr) {
        logAudit("WARN", `Primary database file corrupt: ${parseErr.message}. Recovering from backup: ${backupPath}`);
        try {
          await fs.promises.access(backupPath);
          fileContent = await fs.promises.readFile(backupPath, 'utf8');
          data = JSON.parse(fileContent);
          await fs.promises.copyFile(backupPath, resolved);
          hasParsed = true;
        } catch (e) {
          throw parseErr;
        }
      }
    } else {
      try {
        await fs.promises.access(backupPath);
        logAudit("WARN", `Primary database file missing. Recovering from backup: ${backupPath}`);
        fileContent = await fs.promises.readFile(backupPath, 'utf8');
        data = JSON.parse(fileContent);
        await fs.promises.copyFile(backupPath, resolved);
        hasParsed = true;
      } catch (e) {}
    }
  } catch (err) {
    logAudit("ERROR", `Secure Async JSON Read failed for ${resolved}: ${err.message}. Triggering self-healing...`);
    try {
      await fs.promises.access(backupPath);
      fileContent = await fs.promises.readFile(backupPath, 'utf8');
      data = JSON.parse(fileContent);
      try { await fs.promises.copyFile(backupPath, resolved); } catch (e) {}
      hasParsed = true;
    } catch (e) {}
    
    if (!hasParsed) {
      try {
        logAudit("WARN", `Both primary and backup database corrupted for ${resolved}. Re-initializing with default structure.`);
        await fs.promises.writeFile(resolved, JSON.stringify(defaultData, null, 2), 'utf8');
        await fs.promises.writeFile(backupPath, JSON.stringify(defaultData, null, 2), 'utf8');
      } catch (e) {
        logAudit("ERROR", `Failed to self-heal database file ${resolved}: ${e.message}`);
      }
    }
  }

  // Sync to database (SQLite is shadow index, disk is canonical)
  // Return disk-parsed data to preserve exact object shape.
  if (resolved === safeResolvePath(config.dlqPath)) {
    db.db.transaction(() => {
      db.dlq.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.dlq.save(entry);
        }
      }
    })();
    return data;
  }

  if (resolved === safeResolvePath(config.historyPath)) {
    db.db.transaction(() => {
      db.listings.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.listings.save(entry);
        }
      }
    })();
    return data;
  }

  if (resolved === safeResolvePath(path.join(process.cwd(), 'data', 'templates.json'))) {
    db.db.transaction(() => {
      db.templates.clear();
      if (Array.isArray(data)) {
        for (const entry of data) {
          db.templates.save(entry);
        }
      }
    })();
    return data;
  }

  return data;
}

/**
 * Inspects file binary signatures (magic bytes) to extract dimensions.
 * Support PNG and JPEG formats.
 * @param {string} filePath - Absolute path to target image.
 * @returns {{width: number, height: number, type: string}|null} Dimensions or null if unsupported.
 */
function getImageDimensions(filePath) {
  const resolved = safeResolvePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File does not exist: ${resolved}`);
  }

  const fd = fs.openSync(resolved, 'r');
  const buffer = Buffer.alloc(1024 * 64);
  fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);

  const magic = buffer.readUInt32BE(0);
  if (magic === 0x89504E47) { // PNG
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height, type: 'PNG' };
  } else if (buffer.readUInt16BE(0) === 0xFFD8) { // JPEG
    let offset = 2;
    while (offset < buffer.length - 8) {
      const marker = buffer.readUInt16BE(offset);
      offset += 2;
      if (marker === 0xFFC0 || marker === 0xFFC2) {
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        return { width, height, type: 'JPEG' };
      }
      const segmentLength = buffer.readUInt16BE(offset);
      offset += segmentLength;
    }
  } else if (magic === 0x52494646 && buffer.toString('ascii', 8, 12) === 'WEBP') { // WEBP
    return { width: 1600, height: 1600, type: 'WEBP' };
  } else {
    // Check HEIC
    const ftyp = buffer.toString('ascii', 4, 8);
    const brand = buffer.toString('ascii', 8, 12);
    if (ftyp === 'ftyp' && (brand.startsWith('hei') || brand.startsWith('mif') || brand.startsWith('msf'))) {
      return { width: 1600, height: 1600, type: 'HEIC' };
    }
  }
  return null;
}

/**
 * Asserts image file existence, constraints, and valid size/signature.
 * @param {string} filePath - Absolute target path.
 * @throws {Error} if dimensions or signatures fail verification.
 * @returns {void}
 */
function verifyImageFile(filePath) {
  const resolved = safeResolvePath(filePath);
  const stats = fs.statSync(resolved);
  if (stats.size === 0) throw new Error(`File is empty: ${resolved}`);
  if (stats.size > 12 * 1024 * 1024) throw new Error(`File exceeds 12MB limit: ${resolved}`);

  const dimensions = getImageDimensions(resolved);
  if (!dimensions) {
    throw new Error(`Invalid image structure: ${resolved}. File must be a valid JPEG, PNG, WEBP or HEIC.`);
  }

  logAudit("INFO", `Verified image dimensions for ${path.basename(resolved)}: ${dimensions.width}x${dimensions.height} (${dimensions.type})`);

  if (dimensions.width < 500 || dimensions.height < 500) {
    console.warn(`⚠️  Warning: ${path.basename(resolved)} is below eBay's recommended minimum dimension of 500px.`);
  }
}

/**
 * Automatically launches a listing URL in the system browser.
 * @param {string} listingId - Active listing identifier.
 * @returns {void}
 */
function openListingInBrowser(listingId) {
  const url = `https://www.ebay.com/itm/${listingId}`;
  console.log(`Opening live listing link in browser: ${url}`);
  const command = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  exec(`${command} ${url}`, (err) => {
    if (err) logAudit("WARN", `Could not launch browser: ${err.message}`);
  });
}

/**
 * Discovers the best available text editor on the current OS.
 * @returns {string} Editor command executable name.
 */
function getBestSystemEditor() {
  const editors = process.platform === 'win32'
    ? ['code.cmd', 'code', 'notepad']
    : ['code', 'nano', 'vim', 'vi'];

  for (const editor of editors) {
    try {
      execSync(process.platform === 'win32' ? `where ${editor}` : `which ${editor}`, { stdio: 'ignore' });
      return editor.includes('.cmd') ? editor.replace('.cmd', '') : editor;
    } catch (e) {}
  }
  return process.platform === 'win32' ? 'notepad' : 'nano';
}

/**
 * Opens listing JSON configuration in the user's default text editor.
 * Blocks execution until user saves and closes the editor.
 * @param {object} listingData - Current listing schema.
 * @param {function} validateAndFixListingSchema - Schema normalizer.
 * @returns {object} Updated listing object.
 */
function editListingInSystemEditor(listingData, validateAndFixListingSchema) {
  fs.writeFileSync(config.tempPath, JSON.stringify(listingData, null, 2), 'utf8');
  const editor = getBestSystemEditor();
  console.log(`Opening JSON in [${editor}]. Save and CLOSE the editor to complete modifications...`);

  try {
    execSync(`${editor} "${config.tempPath}"`, { stdio: 'inherit' });
    const updatedContent = fs.readFileSync(config.tempPath, 'utf8');
    const updatedData = JSON.parse(updatedContent);
    validateAndFixListingSchema(updatedData);
    if (fs.existsSync(config.tempPath)) fs.unlinkSync(config.tempPath);
    return updatedData;
  } catch (err) {
    console.error("Editor execution failed. Restoring original parameters.", err.message);
    if (fs.existsSync(config.tempPath)) fs.unlinkSync(config.tempPath);
    return listingData;
  }
}

/**
 * Outputs database elements in a structured ASCII table.
 * @param {any[]} data - List of listings.
 * @returns {void}
 */
function printAsciiTable(data) {
  const headers = ['Date', 'SKU', 'eBay Listing ID', 'Title', 'Price', 'Status'];
  const widths = [10, 22, 17, 30, 8, 8];
  
  const border = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  console.log(border);
  console.log('| ' + headers.map((h, i) => h.padEnd(widths[i])).join(' | ') + ' |');
  console.log(border);
  
  data.forEach(row => {
    const date = new Date(row.timestamp).toLocaleDateString().padEnd(widths[0]);
    const sku = String(row.sku || '').slice(0, widths[1]).padEnd(widths[1]);
    const listingId = String(row.listingId || '').slice(0, widths[2]).padEnd(widths[2]);
    const title = String(row.title || '').slice(0, widths[3]).padEnd(widths[3]);
    const price = `$${parseFloat(row.price || 0).toFixed(2)}`.padEnd(widths[4]);
    const status = String(row.status || 'ACTIVE').padEnd(widths[5]);
    console.log(`| ${date} | ${sku} | ${listingId} | ${title} | ${price} | ${status} |`);
  });
  console.log(border);
}

/**
 * Flushes the current SQLite listings state to the disk JSON file.
 * Called after any direct db.listings.save() to keep disk in sync.
 * @returns {void}
 */
function _flushListingsToDisk() {
  try {
    const allListings = db.listings.findAll();
    const resolved = safeResolvePath(config.historyPath);
    fs.writeFileSync(resolved, JSON.stringify(allListings, null, 2), 'utf8');
  } catch (err) {
    logAudit("ERROR", `Failed to flush listings to disk: ${err.message}`);
  }
}

/**
 * Flushes the current SQLite DLQ state to the disk JSON file.
 * Called after any direct db.dlq.save() to keep disk in sync.
 * @returns {void}
 */
function _flushDlqToDisk() {
  try {
    const allDlq = db.dlq.findAll();
    const resolved = safeResolvePath(config.dlqPath);
    fs.writeFileSync(resolved, JSON.stringify(allDlq, null, 2), 'utf8');
  } catch (err) {
    logAudit("ERROR", `Failed to flush DLQ to disk: ${err.message}`);
  }
}

/**
 * Saves a listing entry to SQLite AND flushes to disk.
 * Use this from routes instead of raw db.listings.save().
 * @param {Object} entry - Listing object with at least a `sku` field.
 * @returns {void}
 */
function persistListing(entry) {
  db.listings.save(entry);
  _flushListingsToDisk();
}

/**
 * Removes a listing entry from SQLite AND flushes to disk.
 * Use this from routes instead of raw db.listings.delete().
 * @param {string} sku - SKU to delete.
 * @returns {boolean} True if a row was deleted.
 */
function removeListing(sku) {
  const result = db.listings.delete(sku);
  _flushListingsToDisk();
  return result;
}

/**
 * Saves a DLQ entry to SQLite AND flushes to disk.
 * @param {Object} entry - DLQ entry.
 * @returns {void}
 */
function persistDlqEntry(entry) {
  db.dlq.save(entry);
  _flushDlqToDisk();
}

/**
 * Removes a DLQ entry from SQLite AND flushes to disk.
 * @param {string} sku
 * @param {string} platform
 * @returns {boolean}
 */
function removeDlqEntry(sku, platform) {
  const result = db.dlq.delete(sku, platform);
  _flushDlqToDisk();
  return result;
}

/**
 * Saves billing data to SQLite.
 * @param {Object} data - Full billing state object.
 * @returns {void}
 */
function persistBilling(data) {
  db.billing.save(data);
}

/**
 * Appends a newly published listing to the history database.
 * Writes to SQLite AND flushes to disk file.
 * @param {string} sku - Product SKU.
 * @param {string} listingId - eBay Listing ID.
 * @param {string} title - Product Title.
 * @param {number} price - Listing Price.
 * @param {string} categoryId - eBay Category ID.
 * @param {string} offerId - eBay Offer ID.
 * @param {string|null} shopifyId - Shopify Product ID.
 * @returns {void}
 */
function saveListingToHistory(sku, listingId, title, price, categoryId, offerId, shopifyId, status = "ACTIVE", listingDetails = null, woocommerceId = null, etsyId = null) {
  try {
    const existing = db.listings.findBySku(sku) || {};
    const entry = {
      timestamp: new Date().toISOString(),
      sku,
      listingId: listingId || existing.listingId || null,
      title,
      price: parseFloat(price),
      categoryId,
      offerId: offerId || existing.offerId || null,
      shopifyId: shopifyId || existing.shopifyId || null,
      woocommerceId: woocommerceId || existing.woocommerceId || null,
      etsyId: etsyId || existing.etsyId || null,
      status,
      brand: listingDetails ? (listingDetails.brand || "Generic") : (existing.brand || "Generic"),
      veroWarning: listingDetails ? (!!listingDetails.veroWarning) : (!!existing.veroWarning),
      priceFloor: existing.priceFloor !== undefined ? existing.priceFloor : null,
      priceCap: existing.priceCap !== undefined ? existing.priceCap : null,
      priceLocked: existing.priceLocked !== undefined ? existing.priceLocked : false,
      listingDetails: listingDetails || existing.listingDetails || null
    };
    persistListing(entry);
    logAudit("INFO", `Saved listing to history via SQLite. SKU: ${sku}, Status: ${status}, Listing ID: ${listingId}`);
  } catch (err) {
    logAudit("ERROR", `Failed to save listing to history: ${err.message}`);
  }
}

/**
 * Reads listing history and prints it as a formatted ASCII table.
 * @returns {void}
 */
function showHistory() {
  const history = db.listings.findAll();
  if (history.length === 0) {
    console.log("No listing history found.");
    return;
  }
  console.log("\n=================== EBAY LISTING HISTORY ===================");
  printAsciiTable(history);
  console.log("============================================================\n");
}

/**
 * Resizes and optimizes an image by centering it on a white square canvas.
 * Uses high-performance sharp pipeline.
 * @param {string} inputPath - Absolute path to original image.
 * @param {string} outputPath - Absolute path to save optimized JPEG.
 * @param {number} [canvasSize=1600] - Output square width/height in pixels.
 * @returns {Promise<void>}
 */
async function optimizeImageNative(inputPath, outputPath, canvasSize = 1600, watermarkText = null) {
  const resolvedIn = safeResolvePath(inputPath);
  const resolvedOut = safeResolvePath(outputPath);

  try {
    const imagePipeline = require('./lib/imagePipeline');
    const result = await imagePipeline.processImageSource(resolvedIn, {
      canvasSize,
      watermarkText,
      watermark: !!watermarkText
    });
    
    // Copy output to target outputPath if they differ
    if (path.resolve(result.outputPath) !== resolvedOut) {
      fs.copyFileSync(result.outputPath, resolvedOut);
      try { fs.unlinkSync(result.outputPath); } catch (e) {}
    }
  } catch (err) {
    logAudit("WARN", `Sharp image optimization failed: ${err.message}. Falling back to copy...`);
    try {
      fs.copyFileSync(resolvedIn, resolvedOut);
    } catch (e) {
      throw new Error(`Image optimization and fallback failed: ${e.message}`);
    }
  }
}

/**
 * Scans the uploads folder and deletes files older than 24 hours.
 * @returns {void}
 */
function cleanOldTempFiles() {
  try {
    const dir = config.uploadTempDir;
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    const now = Date.now();
    const cutoff = 24 * 60 * 60 * 1000;
    
    let count = 0;
    for (const file of files) {
      if (file === 'watch' || file === 'processed') continue;
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      if (stats.isFile() && (now - stats.mtimeMs > cutoff)) {
        fs.unlinkSync(filePath);
        count++;
      }
    }
    if (count > 0) {
      logAudit("INFO", `Cleaned up ${count} temporary upload files older than 24 hours.`);
    }
  } catch (err) {
    logAudit("WARN", `Failed to clean old temp files: ${err.message}`);
  }
}

/**
 * Strips script tags, iframe tags, and inline event handlers from an HTML description.
 * @param {string} html - HTML string.
 * @returns {string} Sanitized HTML.
 */
function stripScriptsAndIframes(html) {
  if (typeof html !== 'string') return html;
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+\s*=\s*(['"])(.*?)\1/gi, '');
}

module.exports = {
  sanitizeLog,
  logAudit,
  safeResolvePath,
  MAX_LISTING_IMAGES,
  isBlockedHostname,
  validateRemoteImageUrl,
  resolveUploadsPath,
  writeJsonFileSecure,
  writeJsonFileSecureAsync,
  readJsonFileSecure,
  readJsonFileSecureAsync,
  getImageDimensions,
  verifyImageFile,
  openListingInBrowser,
  getBestSystemEditor,
  editListingInSystemEditor,
  printAsciiTable,
  saveListingToHistory,
  showHistory,
  optimizeImageNative,
  asyncLocalStorage,
  cleanOldTempFiles,
  stripScriptsAndIframes,
  persistListing,
  removeListing,
  persistDlqEntry,
  removeDlqEntry,
  persistBilling
};
