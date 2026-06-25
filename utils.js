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
    const timestamp = new Date().toISOString();
    const store = asyncLocalStorage.getStore();
    const activeTraceId = traceId || (store ? store.traceId : null);
    
    const logEntry = {
      timestamp,
      level,
      message: sanitizeLog(message),
      traceId: activeTraceId || null,
      data: data ? JSON.parse(sanitizeLog(JSON.stringify(data))) : null
    };
    
    fs.appendFileSync(config.logPath, JSON.stringify(logEntry) + '\n', 'utf8');
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

/**
 * Writes data atomically to a JSON file with lockfile concurrency control to prevent corruption.
 * @param {string} filePath - Absolute path to file.
 * @param {any} data - JS payload.
 * @returns {void}
 */
function writeJsonFileSecure(filePath, data) {
  const resolved = safeResolvePath(filePath);
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
}

/**
 * Reads a JSON file, checking lock state and falling back to backup if primary is corrupted.
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

  try {
    if (fs.existsSync(resolved)) {
      try {
        return JSON.parse(fs.readFileSync(resolved, 'utf8'));
      } catch (parseErr) {
        logAudit("WARN", `Primary database file corrupt: ${parseErr.message}. Recovering from backup: ${backupPath}`);
        if (fs.existsSync(backupPath)) {
          const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
          fs.copyFileSync(backupPath, resolved);
          return data;
        }
        throw parseErr;
      }
    }
    if (fs.existsSync(backupPath)) {
      logAudit("WARN", `Primary database file missing. Recovering from backup: ${backupPath}`);
      const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      fs.copyFileSync(backupPath, resolved);
      return data;
    }
  } catch (err) {
    logAudit("ERROR", `Secure JSON Read failed for ${resolved}: ${err.message}. Triggering self-healing...`);
    if (fs.existsSync(backupPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        try { fs.copyFileSync(backupPath, resolved); } catch (e) {}
        return data;
      } catch (e) {}
    }
    try {
      logAudit("WARN", `Both primary and backup database corrupted for ${resolved}. Re-initializing with default structure.`);
      fs.writeFileSync(resolved, JSON.stringify(defaultData, null, 2), 'utf8');
      fs.writeFileSync(backupPath, JSON.stringify(defaultData, null, 2), 'utf8');
    } catch (e) {
      logAudit("ERROR", `Failed to self-heal database file ${resolved}: ${e.message}`);
    }
  }
  return defaultData;
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

  if (buffer.readUInt32BE(0) === 0x89504E47) { // PNG
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
    throw new Error(`Invalid image structure: ${resolved}. File must be a valid JPEG or PNG.`);
  }

  logAudit("INFO", `Verified image dimensions for ${path.basename(resolved)}: ${dimensions.width}x${dimensions.height}`);

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
 * Appends a newly published listing to the history database.
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
    const history = readJsonFileSecure(config.historyPath, []);
    const existingIndex = history.findIndex(item => item.sku === sku);
    const existingEntry = existingIndex !== -1 ? history[existingIndex] : {};
    
    const entry = {
      timestamp: new Date().toISOString(),
      sku,
      listingId: listingId || existingEntry.listingId || null,
      title,
      price: parseFloat(price),
      categoryId,
      offerId: offerId || existingEntry.offerId || null,
      shopifyId: shopifyId || existingEntry.shopifyId || null,
      woocommerceId: woocommerceId || existingEntry.woocommerceId || null,
      etsyId: etsyId || existingEntry.etsyId || null,
      status,
      brand: listingDetails ? (listingDetails.brand || "Generic") : (existingEntry.brand || "Generic"),
      veroWarning: listingDetails ? (!!listingDetails.veroWarning) : (!!existingEntry.veroWarning),
      listingDetails: listingDetails || existingEntry.listingDetails || null
    };
    if (existingIndex !== -1) {
      history[existingIndex] = entry;
    } else {
      history.push(entry);
    }
    writeJsonFileSecure(config.historyPath, history);
    logAudit("INFO", `Saved listing to history. SKU: ${sku}, Status: ${status}, Listing ID: ${listingId}`);
  } catch (err) {
    logAudit("ERROR", `Failed to save listing to history: ${err.message}`);
  }
}

/**
 * Reads listing history and prints it as a formatted ASCII table.
 * @returns {void}
 */
function showHistory() {
  const history = readJsonFileSecure(config.historyPath, []);
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
 * Uses PowerShell System.Drawing natively on Windows for zero npm dependencies.
 * @param {string} inputPath - Absolute path to original image.
 * @param {string} outputPath - Absolute path to save optimized JPEG.
 * @param {number} [canvasSize=1600] - Output square width/height in pixels.
 * @returns {Promise<void>}
 */
async function optimizeImageNative(inputPath, outputPath, canvasSize = 1600, watermarkText = null) {
  const resolvedIn = safeResolvePath(inputPath);
  const resolvedOut = safeResolvePath(outputPath);
  
  if (process.platform !== 'win32') {
    fs.copyFileSync(resolvedIn, resolvedOut);
    return;
  }
  
  const escapedIn = resolvedIn.replace(/'/g, "''");
  const escapedOut = resolvedOut.replace(/'/g, "''");
  const activeWatermark = watermarkText || config.getWATERMARK_TEXT() || "";
  const escapedWatermark = activeWatermark.replace(/'/g, "''");
  
  const psScript = `
    Add-Type -AssemblyName System.Drawing;
    $src = [System.Drawing.Image]::FromFile('${escapedIn}');
    $bmp = New-Object System.Drawing.Bitmap(${canvasSize}, ${canvasSize});
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.Clear([System.Drawing.Color]::White);
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality;
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality;
    $srcRatio = $src.Width / $src.Height;
    if ($srcRatio -gt 1) {
      $w = ${canvasSize};
      $h = [math]::Round(${canvasSize} / $srcRatio);
    } else {
      $h = ${canvasSize};
      $w = [math]::Round(${canvasSize} * $srcRatio);
    }
    $x = [int][math]::Round((${canvasSize} - $w) / 2);
    $y = [int][math]::Round((${canvasSize} - $h) / 2);
    $w = [int]$w;
    $h = [int]$h;
    $ia = New-Object System.Drawing.Imaging.ImageAttributes;
    $cm = New-Object System.Drawing.Imaging.ColorMatrix;
    $cm.Matrix00 = 1.15;
    $cm.Matrix11 = 1.15;
    $cm.Matrix22 = 1.15;
    $cm.Matrix33 = 1.0;
    $cm.Matrix40 = -0.075;
    $cm.Matrix41 = -0.075;
    $cm.Matrix42 = -0.075;
    $cm.Matrix44 = 1.0;
    $ia.SetColorMatrix($cm);
    $destRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h);
    $g.DrawImage($src, $destRect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia);
    
    # Draw Watermark text if defined
    $wmText = '${escapedWatermark}';
    if ($wmText) {
      $font = New-Object System.Drawing.Font("Arial", 28, [System.Drawing.FontStyle]::Bold);
      $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(80, 180, 180, 180));
      $sf = New-Object System.Drawing.StringFormat;
      $sf.Alignment = [System.Drawing.StringAlignment]::Far;
      $sf.LineAlignment = [System.Drawing.StringAlignment]::Far;
      $rect = New-Object System.Drawing.RectangleF(0, 0, ${canvasSize} - 40, ${canvasSize} - 40);
      $g.DrawString($wmText, $font, $brush, $rect, $sf);
      $brush.Dispose();
      $font.Dispose();
    }
    
    $bmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Jpeg);
    $ia.Dispose();
    $g.Dispose();
    $bmp.Dispose();
    $src.Dispose();
  `;

  const tempPs1Path = path.join(config.uploadTempDir, `opt-${Date.now()}-${Math.round(Math.random() * 1000)}.ps1`);
  fs.writeFileSync(tempPs1Path, psScript, 'utf8');

  return new Promise((resolve, reject) => {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPs1Path}"`, (err, stdout, stderr) => {
      try { fs.unlinkSync(tempPs1Path); } catch (e) {}
      if (err) {
        logAudit("WARN", `Native image optimization failed: ${err.message}. Copying fallback...`);
        try {
          fs.copyFileSync(resolvedIn, resolvedOut);
          resolve();
        } catch (e) {
          reject(new Error(`Image optimization and fallback failed: ${e.message}`));
        }
      } else {
        logAudit("INFO", `Successfully optimized image natively: ${path.basename(resolvedOut)}`);
        resolve();
      }
    });
  });
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

module.exports = {
  sanitizeLog,
  logAudit,
  safeResolvePath,
  writeJsonFileSecure,
  readJsonFileSecure,
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
  cleanOldTempFiles
};
