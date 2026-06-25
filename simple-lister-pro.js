const fs = require('fs');
const path = require('path');
const config = require('./config');
const utils = require('./utils');
const ebayClient = require('./ebayClient');
const geminiClient = require('./geminiClient');
const webServer = require('./webServer');
const readline = require('readline');

// Operational File Paths
const envPath = config.envPath;
const tempPath = config.tempPath;
const recoveryPath = config.recoveryPath;
const historyPath = config.historyPath;
const uploadTempDir = config.uploadTempDir;
let shopifyLocationId = null;

const boldBlue = "\x1b[1;34m";
const boldGreen = "\x1b[1;32m";
const yellow = "\x1b[33m";
const reset = "\x1b[0m";

function cleanupTempFiles() {
  if (fs.existsSync(tempPath)) {
    try { fs.unlinkSync(tempPath); } catch (e) {}
  }
  if (fs.existsSync(uploadTempDir)) {
    try {
      const files = fs.readdirSync(uploadTempDir);
      for (const file of files) {
        fs.unlinkSync(path.join(uploadTempDir, file));
      }
    } catch (e) {}
  }
}

// Clean signals registration
process.on('exit', cleanupTempFiles);
process.on('SIGINT', () => {
  cleanupTempFiles();
  utils.logAudit("WARN", "Process aborted (SIGINT).");
  process.exit(130);
});
process.on('uncaughtException', (err) => {
  console.error("\n💥 Critical Unhandled Exception:", err.message);
  utils.logAudit("FATAL", `Uncaught exception: ${err.message}`, { stack: err.stack });
  cleanupTempFiles();
  process.exit(1);
});

// Session State Functions
function saveSessionState(state) {
  try {
    fs.writeFileSync(recoveryPath, JSON.stringify(state, null, 2), 'utf8');
    utils.logAudit("INFO", `Session state saved at stage: ${state.stage}`);
  } catch (err) {
    utils.logAudit("WARN", `Failed to save session state: ${err.message}`);
  }
}

async function loadSessionState() {
  try {
    if (fs.existsSync(recoveryPath)) {
      const content = fs.readFileSync(recoveryPath, 'utf8');
      const state = JSON.parse(content);
      const answer = await askQuestion(`\n🔄 Found an unfinished listing session from a previous run (Stage: ${state.stage}, SKU: ${state.sku}).\nDo you want to resume it? (y/n): `);
      if (answer.toLowerCase() === 'y') {
        utils.logAudit("INFO", `Session resumed at stage: ${state.stage}`);
        return state;
      } else {
        clearSessionState();
      }
    }
  } catch (err) {
    utils.logAudit("WARN", `Failed to load session state: ${err.message}`);
  }
  return null;
}

function clearSessionState() {
  try {
    if (fs.existsSync(recoveryPath)) {
      fs.unlinkSync(recoveryPath);
      utils.logAudit("INFO", "Session state cleared.");
    }
  } catch (err) {
    utils.logAudit("WARN", `Failed to clear session state: ${err.message}`);
  }
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

/**
 * Clusters loose files in the watch directory by their modification time.
 * Group files that were modified within 2 minutes (120000 ms) of each other.
 * @param {string[]} files - List of file paths.
 * @returns {string[][]} Array of clustered file paths.
 */
function clusterFilesByTime(files) {
  if (files.length === 0) return [];
  
  const fileStats = files.map(file => {
    try {
      const stats = fs.statSync(file);
      return { path: file, mtime: stats.mtimeMs };
    } catch (e) {
      return { path: file, mtime: Date.now() };
    }
  });

  // Sort files by modification time
  fileStats.sort((a, b) => a.mtime - b.mtime);

  const clusters = [];
  let currentCluster = [fileStats[0].path];
  let lastMtime = fileStats[0].mtime;

  for (let i = 1; i < fileStats.length; i++) {
    const item = fileStats[i];
    if (item.mtime - lastMtime <= 120000) { // 2 minutes window
      currentCluster.push(item.path);
    } else {
      clusters.push(currentCluster);
      currentCluster = [item.path];
    }
    lastMtime = item.mtime;
  }
  clusters.push(currentCluster);
  return clusters;
}

/**
 * Pre-optimizes local images before sending them to Gemini and uploading.
 * @param {string[]} imagePaths - Original image paths.
 * @returns {Promise<string[]>} List of optimized image paths (or original paths on fallback).
 */
async function preOptimizeImages(imagePaths) {
  const optimizedPaths = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const originalPath = imagePaths[i];
    const optFilename = `opt-cli-${Date.now()}-${i}-${Math.round(Math.random() * 1000)}.jpg`;
    const optPath = path.join(uploadTempDir, optFilename);
    try {
      await utils.optimizeImageNative(originalPath, optPath, 1600);
      optimizedPaths.push(optPath);
    } catch (e) {
      utils.logAudit("WARN", `Failed to pre-optimize image ${originalPath}: ${e.message}`);
      optimizedPaths.push(originalPath);
    }
  }
  return optimizedPaths;
}

/**
 * Executes the entire listing pipeline programmatically without human review prompts.
 * @param {string[]} validPhotos - List of validated local image paths.
 * @param {string|null} [barcode] - Optional barcode/UPC.
 * @param {string|null} [customNotes] - Optional custom notes.
 * @returns {Promise<void>}
 */
async function runAutoListingPipeline(validPhotos, barcode = null, customNotes = null) {
  await ebayClient.refreshEbayAccessToken();

  let upcData = null;
  if (barcode) {
    upcData = await ebayClient.lookupUPCOnEbay(barcode);
  }

  console.log(`Pre-optimizing ${validPhotos.length} photo(s)...`);
  const optPhotos = await preOptimizeImages(validPhotos);

  try {
    console.log(`Analyzing ${optPhotos.length} photo(s) with Gemini AI...`);
    const fileBuffers = optPhotos.map(p => fs.readFileSync(p));
    
    // Vision auto-detects UPC inside runAIOrchestration and does lookup automatically!
    const finalListing = await geminiClient.runAIOrchestration(
      fileBuffers, 
      optPhotos.map(p => path.basename(p)), 
      barcode, 
      customNotes, 
      upcData
    );

    // Deduplication check: verify if a similar listing was created within the last 60 minutes
    const history = utils.readJsonFileSecure(historyPath, []);
    const isDuplicate = history.some(item => {
      if (item.status !== "ACTIVE" && item.status !== "DRAFT") return false;
      const ageMs = Date.now() - new Date(item.timestamp).getTime();
      if (ageMs > 60 * 60 * 1000) return false;
      const t1 = String(item.title).toLowerCase().replace(/[^a-z0-9]/g, '');
      const t2 = String(finalListing.title).toLowerCase().replace(/[^a-z0-9]/g, '');
      return t1 === t2;
    });

    if (isDuplicate) {
      const errMsg = `Deduplication: A listing with a very similar title ("${finalListing.title}") was published or created in the last 60 minutes. Skipping auto-publish.`;
      console.warn(`\n⚠️  ${errMsg}\n`);
      utils.logAudit("WARN", errMsg);
      return;
    }

    console.log(`Uploading ${optPhotos.length} photo(s) to temporary image host...`);
    const imageUrls = await uploadImagesConcurrently(optPhotos, 2);

    const skuPrefix = config.getSKU_PREFIX();
    const sku = `${skuPrefix}SKU-${Date.now()}`;

    if (process.argv.includes('--draft')) {
      const listingDetails = {
        ...finalListing,
        imageUrls
      };
      utils.saveListingToHistory(sku, null, finalListing.title, finalListing.suggestedPrice, finalListing.categoryId, null, null, "DRAFT", listingDetails);
      console.log(`\n📝 Draft saved successfully with SKU: ${sku}`);
      return;
    }

    // Apply auto-pricing strategy from config
    const strategy = config.getDEFAULT_PRICING_STRATEGY().toUpperCase();
    let price = finalListing.suggestedPrice;
    if (strategy === "FAST") {
      price = Number((price * 0.9).toFixed(2));
    } else if (strategy === "PREMIUM") {
      price = Number((price * 1.1).toFixed(2));
    }
    finalListing.suggestedPrice = price;

    // Enforce defaults for policy profiles
    const selectedShipping = config.getDEFAULT_SHIPPING_OPTION();
    const selectedReturns = config.getDEFAULT_RETURN_OPTION();
    const isImmediatePayment = config.getDEFAULT_IMMEDIATE_PAYMENT();

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

    const inventoryItem = {
      condition: finalListing.condition,
      availability: { shipToLocationAvailability: { quantity: 1 } },
      product: {
        title: finalListing.title.slice(0, 80),
        description: finalListing.description,
        brand: finalListing.brand,
        mpn: finalListing.model || "Does Not Apply",
        aspects: Object.fromEntries(Object.entries(finalListing.aspects).map(([k, v]) => [k, [v]])),
        imageUrls: imageUrls
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
    
    console.log(`Step 1/3: Creating inventory item for SKU: ${sku}...`);
    await ebayClient.ebayRequest(`/inventory_item/${encodeURIComponent(sku)}`, "PUT", inventoryItem);

    const policies = await ebayClient.getOrCreateListingPolicies(selectedShipping, selectedReturns, isImmediatePayment);
    
    const offerPayload = {
      sku: sku,
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 1,
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
        price: { currency: "USD", value: String(finalListing.suggestedPrice) }
      }
    };

    console.log("Step 2/3: Creating offer...");
    const offerResponse = await ebayClient.ebayRequest("/offer", "POST", offerPayload);
    const offerId = offerResponse.offerId;

    console.log(`Step 3/3: Publishing offer ${offerId}...`);
    const publishResponse = await ebayClient.ebayRequest(`/offer/${offerId}/publish`, "POST");
    
    let shopifyId = null;
    if (config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()) {
      shopifyId = await crossPostToShopify(finalListing, imageUrls, sku);
    }
    let woocommerceId = null;
    if (config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()) {
      woocommerceId = await crossPostToWooCommerce(finalListing, imageUrls, sku);
    }
    let etsyId = null;
    if (config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN()) {
      etsyId = await crossPostToEtsy(finalListing, sku);
    }

    console.log(`\n🎉 SUCCESS! eBay Listing is live!`);
    console.log(`eBay Listing ID: ${publishResponse.listingId}`);
    if (shopifyId) {
      console.log(`Shopify Product ID: ${shopifyId}`);
      const shopName = config.getSHOPIFY_SHOP_NAME();
      if (shopName) {
        console.log(`Shopify Admin URL:  https://${shopName}.myshopify.com/admin/products/${shopifyId}`);
      }
    }
    if (woocommerceId) {
      console.log(`WooCommerce Product ID: ${woocommerceId}`);
    }
    if (etsyId) {
      console.log(`Etsy Listing ID: ${etsyId}`);
    }
    
    utils.saveListingToHistory(sku, publishResponse.listingId, finalListing.title, finalListing.suggestedPrice, finalListing.categoryId, offerId, shopifyId);
    if (woocommerceId || etsyId) {
      const history = utils.readJsonFileSecure(config.historyPath, []);
      const item = history.find(i => i.sku === sku);
      if (item) {
        if (woocommerceId) item.woocommerceId = String(woocommerceId);
        if (etsyId) item.etsyId = String(etsyId);
        utils.writeJsonFileSecure(config.historyPath, history);
      }
    }
    utils.openListingInBrowser(publishResponse.listingId);
  } finally {
    // Cleanup any temporary optimized files we created
    optPhotos.forEach(p => {
      if (validPhotos.indexOf(p) === -1) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
      }
    });
  }
}

/**
 * Verifies that a list of candidate files are stable (file sizes do not change for 2 seconds) and not locked.
 * @param {string[]} filePaths - Candidate files to check.
 * @returns {Promise<string[]>} List of stable file paths.
 */
async function filterStableFiles(filePaths) {
  const stable = [];
  const initialSizes = {};
  const candidates = [];

  for (const f of filePaths) {
    const lockFile = `${f}.lock`;
    if (fs.existsSync(lockFile)) {
      utils.logAudit("INFO", `File ${f} is locked via lock file, skipping for now.`);
      continue;
    }
    try {
      const stat = fs.statSync(f);
      initialSizes[f] = stat.size;
      candidates.push(f);
    } catch (err) {
      utils.logAudit("INFO", `File ${f} is locked or inaccessible: ${err.message}, skipping.`);
    }
  }

  if (candidates.length === 0) return [];

  await new Promise(resolve => setTimeout(resolve, 2000));

  for (const f of candidates) {
    try {
      const lockFile = `${f}.lock`;
      if (fs.existsSync(lockFile)) {
        continue;
      }
      const stat = fs.statSync(f);
      if (stat.size > 0 && stat.size === initialSizes[f]) {
        stable.push(f);
      } else {
        utils.logAudit("INFO", `File ${f} size changed (from ${initialSizes[f]} to ${stat.size}), skipping.`);
      }
    } catch (err) {
      utils.logAudit("INFO", `File ${f} became inaccessible during stability check: ${err.message}`);
    }
  }
  return stable;
}

/**
 * Starts a background watch daemon loop to automatically list photos appearing in watch folder.
 * @returns {Promise<void>}
 */
async function startWatchDaemon() {
  const watchDir = path.join(uploadTempDir, 'watch');
  const processedDir = path.join(uploadTempDir, 'processed');

  if (!fs.existsSync(watchDir)) {
    fs.mkdirSync(watchDir, { recursive: true });
  }
  if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
  }

  console.log(`\n👁️  ${boldGreen}Watching directory:${reset} ${watchDir}`);
  console.log(`📂 Processed items will be moved to: ${processedDir}`);
  console.log("Press Ctrl+C to terminate watch daemon.\n");

  utils.logAudit("INFO", "Directory watch daemon started.");

  let isProcessing = false;
  let debounceTimeout = null;
  const processedSignatures = new Set();

  async function processWatchDirectory() {
    if (isProcessing) return;
    isProcessing = true;
    try {
      // 1. Process subdirectories (each directory is a distinct product)
      const items = fs.readdirSync(watchDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const dirPath = path.join(watchDir, item.name);
          let files = [];
          try {
            files = fs.readdirSync(dirPath)
              .map(f => path.join(dirPath, f))
              .filter(f => {
                try {
                  return fs.existsSync(f) && fs.statSync(f).isFile() && /\.(jpe?g|png)$/i.test(f);
                } catch (e) {
                  return false;
                }
              });
          } catch (e) {
            utils.logAudit("WARN", `Failed to read subdirectory ${dirPath}: ${e.message}`);
          }

          if (files.length > 0) {
            const stableFiles = await filterStableFiles(files);
            if (stableFiles.length !== files.length) {
              utils.logAudit("INFO", `Subdirectory ${item.name} contains unstable/locked files. Skipping this scan.`);
              continue;
            }

            const dirSignature = stableFiles.map(f => {
              try {
                const s = fs.statSync(f);
                return `${path.basename(f)}_${s.size}_${s.mtimeMs}`;
              } catch (e) {
                return `${path.basename(f)}_unknown`;
              }
            }).join('|');

            if (processedSignatures.has(dirSignature)) {
              continue;
            }

            console.log(`\n[Watch] Found product directory: ${item.name} with ${stableFiles.length} stable images.`);
            utils.logAudit("INFO", `Watch daemon processing directory: ${item.name}`);

            try {
              await runAutoListingPipeline(stableFiles);
              const destDir = path.join(processedDir, `${item.name}-${Date.now()}`);
              fs.renameSync(dirPath, destDir);
              console.log(`[Watch] Completed. Moved directory to processed.`);
              processedSignatures.add(dirSignature);
              if (processedSignatures.size > 200) {
                const firstVal = processedSignatures.values().next().value;
                processedSignatures.delete(firstVal);
              }
            } catch (err) {
              console.error(`[Watch] Failed to process directory ${item.name}: ${err.message}`);
              utils.logAudit("ERROR", `Failed to process directory ${item.name}: ${err.message}`);
            }
          }
        }
      }

      // 2. Process loose files in the root watch folder (group by time)
      const looseFiles = fs.readdirSync(watchDir)
        .map(f => path.join(watchDir, f))
        .filter(f => {
          try {
            return fs.existsSync(f) && fs.statSync(f).isFile() && /\.(jpe?g|png)$/i.test(f);
          } catch (e) {
            return false;
          }
        });

      if (looseFiles.length > 0) {
        const stableLooseFiles = await filterStableFiles(looseFiles);
        if (stableLooseFiles.length > 0) {
          const clusters = clusterFilesByTime(stableLooseFiles);
          for (let idx = 0; idx < clusters.length; idx++) {
            const cluster = clusters[idx];
          const clusterSignature = cluster.map(f => {
            try {
              const s = fs.statSync(f);
              return `${path.basename(f)}_${s.size}_${s.mtimeMs}`;
            } catch (e) {
              return `${path.basename(f)}_unknown`;
            }
          }).join('|');

          if (processedSignatures.has(clusterSignature)) {
            continue;
          }

          console.log(`\n[Watch] Found clustered loose images (${cluster.length} files) from timestamps.`);
          utils.logAudit("INFO", `Watch daemon processing clustered loose images: ${cluster.map(f => path.basename(f)).join(', ')}`);

          try {
            await runAutoListingPipeline(cluster);
            cluster.forEach(file => {
              try {
                if (fs.existsSync(file)) {
                  const dest = path.join(processedDir, `${Date.now()}-${path.basename(file)}`);
                  fs.renameSync(file, dest);
                }
              } catch (renameErr) {
                utils.logAudit("ERROR", `Failed to move file ${file} to processed: ${renameErr.message}`);
              }
            });
            console.log(`[Watch] Completed. Moved files to processed.`);
            processedSignatures.add(clusterSignature);
            if (processedSignatures.size > 200) {
              const firstVal = processedSignatures.values().next().value;
              processedSignatures.delete(firstVal);
            }
          } catch (err) {
            console.error(`[Watch] Failed to process clustered loose files: ${err.message}`);
            utils.logAudit("ERROR", `Failed to process clustered loose files: ${err.message}`);
          }
        }
      }
    }
    } catch (e) {
      utils.logAudit("ERROR", `Watch daemon scanning error: ${e.message}`);
    } finally {
      isProcessing = false;
    }
  }

  const triggerProcessing = () => {
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(async () => {
      await processWatchDirectory();
    }, 2000);
  };

  // Process any files already present on startup
  triggerProcessing();

  const watcher = fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
    if (filename) {
      if (filename.includes('processed')) return;
      utils.logAudit("INFO", `Watch event detected: [${eventType}] on ${filename}`);
      triggerProcessing();
    }
  });

  // Keep watcher active (do not unref, so the process remains alive)
  // watcher.unref();
}

async function main() {
  // Pre-flight environment diagnostics checks
  try {
    config.runDiagnostics();
    utils.cleanOldTempFiles();
  } catch (err) {
    console.error(`\n❌ Pre-flight diagnostics failed: ${err.message}`);
    utils.logAudit("FATAL", `Pre-flight diagnostics failed: ${err.message}`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  
  if (args.includes('--bootstrap')) {
    console.log(`\n${boldBlue}=================== EBAY LISTER SETUP WIZARD ===================${reset}`);
    console.log("This will configure your local .env file. Press ENTER to skip any optional setting.\n");

    let geminiKey = await askQuestion("1. Google Gemini API Key: ");
    geminiKey = geminiKey.trim();
    if (geminiKey && (!geminiKey.startsWith("AIzaSy") || geminiKey.length !== 39)) {
      console.log(`${yellow}⚠️  Warning: Gemini API Key format looks unusual (typically starts with 'AIzaSy' and is 39 characters).${reset}`);
    }

    let clientId = await askQuestion("2. eBay App ID (Client ID): ");
    clientId = clientId.trim();
    if (clientId && clientId.includes(" ")) {
      console.log(`${yellow}⚠️  Warning: eBay Client ID should not contain spaces.${reset}`);
    }

    let clientSecret = await askQuestion("3. eBay Cert ID (Client Secret): ");
    clientSecret = clientSecret.trim();

    let refreshToken = await askQuestion("4. eBay Refresh Token (Long-Lived): ");
    refreshToken = refreshToken.trim();
    if (refreshToken && refreshToken.length < 100) {
      console.log(`${yellow}⚠️  Warning: eBay Refresh Token is typically a very long string.${reset}`);
    }

    let locationKey = await askQuestion("5. eBay Merchant Location Key [default]: ") || "default";
    locationKey = locationKey.trim();

    console.log(`\n${boldBlue}Shopify Cross-Posting (Optional):${reset}`);
    let shopName = await askQuestion("6. Shopify Shop Name (ex: 'my-shop' for my-shop.myshopify.com): ");
    
    // Auto-parse shop name
    let cleanShopName = shopName.trim();
    if (cleanShopName) {
      cleanShopName = cleanShopName.replace(/^https?:\/\//i, '');
      cleanShopName = cleanShopName.replace(/\.myshopify\.com\/?$/i, '');
      cleanShopName = cleanShopName.split('/')[0];
      if (cleanShopName !== shopName.trim()) {
        console.log(`${boldGreen}ℹ Auto-parsed Shopify Shop Name: ${cleanShopName}${reset}`);
      }
    }

    let shopifyToken = await askQuestion("7. Shopify Admin Access Token: ");
    shopifyToken = shopifyToken.trim();

    const envContent = `
# Gemini Credentials
GEMINI_API_KEY=${geminiKey}

# eBay Client Keys (Required for auto-refresh token renewal)
EBAY_CLIENT_ID=${clientId}
EBAY_CLIENT_SECRET=${clientSecret}
EBAY_REFRESH_TOKEN=${refreshToken}

# Policy Profiles (Optional - if blank, policies will be auto-created on eBay)
EBAY_LOCATION_KEY=${locationKey}

# Custom HTML Terms (Useful for description templates)
SELLER_SHIPPING_TERMS=Shipped next business day with tracking!
SELLER_RETURN_TERMS=No returns accepted unless item is not as described.

# Shopify Multi-channel Integration
SHOPIFY_SHOP_NAME=${cleanShopName}
SHOPIFY_ACCESS_TOKEN=${shopifyToken}
`.trim();

    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log(`\n${boldGreen}Config successfully written to: ${envPath}${reset}`);
    console.log(`${boldBlue}=================================================================${reset}\n`);
    process.exit(0);
  }
  
  if (args.includes('--history')) {
    utils.showHistory();
    process.exit(0);
  }
  if (args.includes('--list-policies')) {
    try {
      await ebayClient.listPolicies();
      process.exit(0);
    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
      process.exit(1);
    }
  }
  if (args.includes('--stats')) {
    const data = utils.readJsonFileSecure(historyPath, []);
    if (data.length === 0) {
      console.log("No listing history found. Stats not available.");
      process.exit(0);
    }
    
    const totalListed = data.length;
    const totalValue = data.reduce((sum, item) => sum + (item.price || 0), 0);
    const averagePrice = totalValue / totalListed;
    
    const categoryCounts = {};
    data.forEach(item => {
      categoryCounts[item.categoryId] = (categoryCounts[item.categoryId] || 0) + 1;
    });

    console.log("\n=================== SELLER PORTFOLIO STATS ===================");
    console.log(`Total Items Listed:   ${totalListed}`);
    console.log(`Total Value Listed:   $${totalValue.toFixed(2)}`);
    console.log(`Average Item Price:   $${averagePrice.toFixed(2)}`);
    console.log("\nTop Listing Categories (By ID):");
    Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([catId, count]) => {
        console.log(`  - Category ID ${catId.padEnd(8)}: ${count} item(s)`);
      });
    console.log("==============================================================\n");
    process.exit(0);
  }
  if (args.includes('--sync')) {
    await ebayClient.syncListingsFromEbay();
    process.exit(0);
  }
  if (args.includes('--gui')) {
    webServer.startWebGuiServer();
    return;
  }

  // End Listing CLI Command
  const endIdx = args.indexOf('--end');
  if (endIdx !== -1 && args[endIdx + 1]) {
    const targetSku = args[endIdx + 1];
    await ebayClient.refreshEbayAccessToken();
    await ebayClient.endListingOnEbay(targetSku);
    process.exit(0);
  }

  // Folder watching daemon mode
  if (args.includes('--watch')) {
    await startWatchDaemon();
    return;
  }

  const isDryRun = args.includes('--dry-run');
  const isDraft = args.includes('--draft');
  const upcIndex = args.indexOf('--upc');
  let barcode = null;
  if (upcIndex !== -1 && args[upcIndex + 1]) {
    barcode = args[upcIndex + 1];
  }

  const notesIndex = args.indexOf('--notes');
  let customNotes = null;
  if (notesIndex !== -1 && args[notesIndex + 1]) {
    customNotes = args[notesIndex + 1];
  }

  const photoArgs = args.filter(a => 
    a !== '--dry-run' && 
    a !== '--draft' && 
    a !== '--bootstrap' && 
    a !== '--list-policies' && 
    a !== '--history' &&
    a !== '--stats' &&
    a !== '--sync' &&
    a !== '--gui' &&
    a !== '--notes' &&
    a !== customNotes &&
    a !== '--upc' &&
    a !== barcode &&
    a !== '--end' &&
    a !== '--auto' &&
    a !== '--watch'
  );

  // Auto/Headless Publish Mode
  if (args.includes('--auto')) {
    console.log(`${boldGreen}🤖 Headless Auto-Publish mode active.${reset}`);
    const validPhotos = [];
    for (const photo of photoArgs) {
      const resolvedPath = path.resolve(photo);
      try {
        utils.verifyImageFile(resolvedPath);
        validPhotos.push(resolvedPath);
      } catch (err) {
        console.error(`❌ Error validating image: ${photo}. ${err.message}`);
        process.exit(1);
      }
    }
    if (validPhotos.length === 0) {
      console.error("❌ Error: No images specified for auto-publish.");
      process.exit(1);
    }
    try {
      await runAutoListingPipeline(validPhotos, barcode, customNotes);
    } catch (err) {
      console.error(`❌ Auto-Publish pipeline failed: ${err.message}`);
    }
    process.exit(0);
  }

  if (photoArgs.length === 0) {
    const bold = "\x1b[1m";
    const green = "\x1b[32m";
    const reset = "\x1b[0m";
    console.log(`${bold}Usage Commands:${reset}`);
    console.log(`  ${green}node simple-lister-pro.js --gui${reset}            - Launch the responsive Local Web Dashboard`);
    console.log(`  ${green}node simple-lister-pro.js <photo1.jpg> [photo2.jpg ...] [--upc UPC] [--notes "details"] [--dry-run]${reset}`);
    console.log(`  ${green}node simple-lister-pro.js <photo1.jpg> [photo2.jpg ...] --auto [--upc UPC] [--notes "details"]${reset}`);
    console.log(`  ${green}node simple-lister-pro.js --watch${reset}          - Watch 'uploads/watch' folder for hands-off listings`);
    console.log(`  ${green}node simple-lister-pro.js --end <sku>${reset}      - End/withdraw active eBay listing`);
    console.log(`  ${green}node simple-lister-pro.js --sync${reset}           - Sync active eBay items to local history`);
    console.log(`  ${green}node simple-lister-pro.js --bootstrap${reset}      - Initial setup wizard for credentials`);
    console.log(`  ${green}node simple-lister-pro.js --list-policies${reset}  - Fetch active shipping/payment/return policy IDs`);
    console.log(`  ${green}node simple-lister-pro.js --history${reset}        - Show ASCII table of previous listings`);
    console.log(`  ${green}node simple-lister-pro.js --stats${reset}          - Show listed counts and category portfolio stats`);
    process.exit(0);
  }

  const validPhotos = [];
  for (const photo of photoArgs) {
    const resolvedPath = path.resolve(photo);
    try {
      utils.verifyImageFile(resolvedPath);
      validPhotos.push(resolvedPath);
    } catch (err) {
      console.error(`Error validating image: ${photo}. ${err.message}`);
      process.exit(1);
    }
  }

  const geminiKey = config.getGEMINI_API_KEY();
  if (!geminiKey && !fs.existsSync(envPath)) {
    console.log("Configuration file (.env) not detected. Initiating bootstrap wizard...");
    await runBootstrapWizard();
  }
  
  if (!geminiKey) {
    console.error("Error: GEMINI_API_KEY is not defined in your environment or .env file.");
    process.exit(1);
  }

  try {
    if (isDryRun) console.log("🧪 DRY RUN ACTIVE - Listings will not be pushed to eBay.\n");

    let listingData = null;
    let imageUrls = [];
    let sku = null;
    let offerId = null;

    const restoredSession = await loadSessionState();
    if (restoredSession) {
      listingData = restoredSession.listingData;
      imageUrls = restoredSession.imageUrls;
      sku = restoredSession.sku;
      offerId = restoredSession.offerId;
      await ebayClient.refreshEbayAccessToken();
    } else {
      if (!isDryRun) {
        await ebayClient.refreshEbayAccessToken();
      }

      let upcData = null;
      if (barcode) {
        upcData = await ebayClient.lookupUPCOnEbay(barcode);
      }

      console.log(`Pre-optimizing ${validPhotos.length} photo(s)...`);
      const optPhotos = await preOptimizeImages(validPhotos);

      try {
        console.log(`Analyzing ${optPhotos.length} photo(s) with Gemini AI...`);
        const fileBuffers = optPhotos.map(p => fs.readFileSync(p));
        listingData = await geminiClient.runAIOrchestration(fileBuffers, optPhotos.map(p => path.basename(p)), barcode, customNotes, upcData);

        if (isDryRun) {
          imageUrls = optPhotos.map((_, i) => `https://example.com/mock-image-${i + 1}.jpg`);
        } else {
          console.log(`Uploading ${optPhotos.length} photo(s) to temporary image host...`);
          imageUrls = await Promise.all(optPhotos.map(p => uploadImage(p)));
        }

        sku = `AUTO-SKU-${Date.now()}`;
        saveSessionState({ stage: "ANALYZED", listingData, imageUrls, sku });
      } finally {
        optPhotos.forEach(p => {
          if (validPhotos.indexOf(p) === -1) {
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
          }
        });
      }
    }

    let finalListing = listingData;
    let loop = true;
    let selectedShipping = "USPS_GROUND";
    let selectedReturns = "NO_RETURNS";
    let isImmediatePayment = true;
    let categorySuggestions = [];

    const token = ebayClient.getAccessToken();
    if (token) {
      categorySuggestions = await ebayClient.getCategorySuggestions(finalListing.title);
    }

    while (loop) {
      if (finalListing.suggestedPrice <= 0 || finalListing.suggestedPrice > 10000) {
        console.warn(`⚠️  Warning: The suggested price of $${finalListing.suggestedPrice} is unusually low/high. Please double check.`);
      }

      console.log("\n=================== REVIEW PROPOSED LISTING ===================");
      console.log(`Title:       ${finalListing.title}`);
      console.log(`Price:       $${finalListing.suggestedPrice.toFixed(2)}`);
      console.log(`Condition:   ${finalListing.condition}`);
      console.log(`Category ID: ${finalListing.categoryId}`);
      if (categorySuggestions.length > 0) {
        console.log("Suggested Categories:");
        categorySuggestions.forEach((s, idx) => {
          console.log(`  [${idx + 1}] ${s.path} (${s.id})`);
        });
      }
      console.log(`Brand:       ${finalListing.brand}`);
      console.log(`Model/MPN:   ${finalListing.model || 'N/A'}`);
      console.log(`Weight:      ${finalListing.weightMajor} lbs ${finalListing.weightMinor} oz`);
      console.log(`Dimensions:  ${finalListing.packageLength} x ${finalListing.packageWidth} x ${finalListing.packageHeight} in`);
      console.log(`Shipping:    ${selectedShipping}`);
      console.log(`Returns:     ${selectedReturns}`);
      console.log(`ImmediatePay:${isImmediatePayment}`);
      console.log(`Photos (${imageUrls.length}):`);
      imageUrls.forEach((url, i) => console.log(`  [${i + 1}]: ${url}`));
      console.log("Item Specifics:");
      Object.entries(finalListing.aspects).forEach(([k, v]) => console.log(`  - ${k}: ${v}`));
      console.log("===============================================================");

      let optQuery = `\nOptions: [P]ublish${isDryRun ? ' (Dry Run)' : ''}, Save as [D]raft, [E]dit in Editor, [C]hange Price/Strategy, [S]hipping/Return settings, [A]bort (p/d/e/c/s/a): `;
      if (categorySuggestions.length > 0) {
        optQuery = `\nOptions: [P]ublish${isDryRun ? ' (Dry Run)' : ''}, Save as [D]raft, [E]dit in Editor, [C]hange Price/Strategy, [S]hipping/Return settings, [T]axonomy/Category select, [A]bort (p/d/e/c/s/t/a): `;
      }

      const choice = isDraft ? 'd' : await askQuestion(optQuery);
      const opt = choice.toLowerCase();
      
      if (opt === 'p') {
        loop = false;
      } else if (opt === 'd') {
        const listingDetails = {
          ...finalListing,
          imageUrls
        };
        utils.saveListingToHistory(sku, null, finalListing.title, finalListing.suggestedPrice, finalListing.categoryId, null, null, "DRAFT", listingDetails);
        console.log(`\n📝 Draft saved successfully with SKU: ${sku}`);
        clearSessionState();
        process.exit(0);
      } else if (opt === 'e') {
        finalListing = utils.editListingInSystemEditor(finalListing, geminiClient.validateAndFixListingSchema);
        saveSessionState({ stage: "REVIEWED", listingData: finalListing, imageUrls, sku, offerId });
      } else if (opt === 't' && categorySuggestions.length > 0) {
        console.log("\nSelect eBay Category:");
        categorySuggestions.forEach((s, idx) => {
          console.log(`  [${idx + 1}] ${s.path} (${s.id})`);
        });
        console.log("  [C] Enter custom Category ID");
        const catChoice = await askQuestion("Choice [1]: ") || "1";
        if (catChoice.toLowerCase() === 'c') {
          const customCat = await askQuestion("Enter custom category ID: ");
          if (customCat) finalListing.categoryId = customCat.trim();
        } else {
          const idx = parseInt(catChoice) - 1;
          if (idx >= 0 && idx < categorySuggestions.length) {
            finalListing.categoryId = categorySuggestions[idx].id;
          }
        }
        saveSessionState({ stage: "REVIEWED", listingData: finalListing, imageUrls, sku, offerId });
      } else if (opt === 's') {
        console.log("\nConfigure Shipping Service:");
        console.log("  [1] Calculated USPS Ground Advantage");
        console.log("  [2] Calculated USPS Priority Mail");
        console.log("  [3] Calculated UPS Ground");
        console.log("  [4] Flat Rate Standard Shipping ($5.00)");
        const sChoice = await askQuestion("Shipping choice [1]: ") || "1";
        if (sChoice === "2") selectedShipping = "USPS_PRIORITY";
        else if (sChoice === "3") selectedShipping = "UPS_GROUND";
        else if (sChoice === "4") selectedShipping = "FLAT_RATE_STANDARD";
        else selectedShipping = "USPS_GROUND";

        console.log("\nConfigure Returns Policy:");
        console.log("  [1] No Returns (As Described Only)");
        console.log("  [2] 30-Day Returns (Buyer Pays)");
        console.log("  [3] 30-Day Free Returns");
        const rChoice = await askQuestion("Return choice [1]: ") || "1";
        if (rChoice === "2") selectedReturns = "30_DAYS_BUYER_PAYS";
        else if (rChoice === "3") selectedReturns = "30_DAYS_FREE";
        else selectedReturns = "NO_RETURNS";

        const immPay = await askQuestion("Require Immediate Payment? (y/n) [y]: ") || "y";
        isImmediatePayment = immPay.toLowerCase() !== 'n';
      } else if (opt === 'c') {
        const basePrice = finalListing.suggestedPrice;
        console.log(`\nSelect Pricing Strategy (Base: $${basePrice.toFixed(2)}):`);
        console.log(`  [1] Fast Sale (-10%): $${(basePrice * 0.9).toFixed(2)}`);
        console.log(`  [2] Market Value:     $${basePrice.toFixed(2)}`);
        console.log(`  [3] Premium Price (+10%): $${(basePrice * 1.1).toFixed(2)}`);
        console.log(`  [4] Enter Custom Price`);
        const priceChoice = await askQuestion("Choice [2]: ") || "2";
        if (priceChoice === "1") finalListing.suggestedPrice = Number((basePrice * 0.9).toFixed(2));
        else if (priceChoice === "3") finalListing.suggestedPrice = Number((basePrice * 1.1).toFixed(2));
        else if (priceChoice === "4") {
          const customVal = await askQuestion("Enter price: $");
          const parsed = parseFloat(customVal);
          if (!isNaN(parsed) && parsed > 0) finalListing.suggestedPrice = parsed;
        }
        saveSessionState({ stage: "REVIEWED", listingData: finalListing, imageUrls, sku, offerId });
      } else {
        console.log("Listing aborted.");
        clearSessionState();
        process.exit(0);
      }
    }

    if (isDryRun) {
      console.log("\n🧪 Dry Run finished. Listing JSON generated:");
      console.log(JSON.stringify(finalListing, null, 2));
      clearSessionState();
      process.exit(0);
    }

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

    if (!restoredSession || restoredSession.stage === "ANALYZED" || restoredSession.stage === "REVIEWED") {
      const skuPrefix = config.getSKU_PREFIX();
      sku = `${skuPrefix}SKU-${Date.now()}`;

      const inventoryItem = {
        condition: finalListing.condition,
        availability: { shipToLocationAvailability: { quantity: 1 } },
        product: {
          title: finalListing.title.slice(0, 80),
          description: finalListing.description,
          brand: finalListing.brand,
          mpn: finalListing.model || "Does Not Apply",
          aspects: Object.fromEntries(Object.entries(finalListing.aspects).map(([k, v]) => [k, [v]])),
          imageUrls: imageUrls
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
      
      console.log(`\nStep 1/3: Creating inventory item for SKU: ${sku}...`);
      await ebayClient.ebayRequest(`/inventory_item/${encodeURIComponent(sku)}`, "PUT", inventoryItem);
      saveSessionState({ stage: "INVENTORY_CREATED", listingData: finalListing, imageUrls, sku });
    }

    if (!offerId) {
      const policies = await ebayClient.getOrCreateListingPolicies(selectedShipping, selectedReturns, isImmediatePayment);
      
      const offerPayload = {
        sku: sku,
        marketplaceId: "EBAY_US",
        format: "FIXED_PRICE",
        availableQuantity: 1,
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
          price: { currency: "USD", value: String(finalListing.suggestedPrice) }
        }
      };

      console.log("Step 2/3: Creating offer...");
      const offerResponse = await ebayClient.ebayRequest("/offer", "POST", offerPayload);
      offerId = offerResponse.offerId;
      saveSessionState({ stage: "OFFER_CREATED", listingData: finalListing, imageUrls, sku, offerId });
    }

    console.log(`Step 3/3: Publishing offer ${offerId}...`);
    const publishResponse = await ebayClient.ebayRequest(`/offer/${offerId}/publish`, "POST");
    
    let shopifyId = null;
    if (config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()) {
      shopifyId = await crossPostToShopify(finalListing, imageUrls, sku);
    }
    let woocommerceId = null;
    if (config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()) {
      woocommerceId = await crossPostToWooCommerce(finalListing, imageUrls, sku);
    }
    let etsyId = null;
    if (config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN()) {
      etsyId = await crossPostToEtsy(finalListing, sku);
    }

    console.log(`\n🎉 SUCCESS! eBay Listing is live!`);
    console.log(`eBay Listing ID: ${publishResponse.listingId}`);
    if (shopifyId) {
      console.log(`Shopify Product ID: ${shopifyId}`);
      const shopName = config.getSHOPIFY_SHOP_NAME();
      if (shopName) {
        console.log(`Shopify Admin URL:  https://${shopName}.myshopify.com/admin/products/${shopifyId}`);
      }
    }
    if (woocommerceId) {
      console.log(`WooCommerce Product ID: ${woocommerceId}`);
    }
    if (etsyId) {
      console.log(`Etsy Listing ID: ${etsyId}`);
    }
    
    utils.saveListingToHistory(sku, publishResponse.listingId, finalListing.title, finalListing.suggestedPrice, finalListing.categoryId, offerId, shopifyId);
    if (woocommerceId || etsyId) {
      const history = utils.readJsonFileSecure(config.historyPath, []);
      const item = history.find(i => i.sku === sku);
      if (item) {
        if (woocommerceId) item.woocommerceId = String(woocommerceId);
        if (etsyId) item.etsyId = String(etsyId);
        utils.writeJsonFileSecure(config.historyPath, history);
      }
    }
    clearSessionState();

    utils.openListingInBrowser(publishResponse.listingId);

  } catch (error) {
    console.error(sanitizeLog(`\n❌ Pipeline Error: ${error.message}`));
    utils.logAudit("ERROR", `Orchestrator failed: ${error.message}`);
  }
}

// Reuse image upload helper for CLI orchestration
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

// Cross-posting delegation to crossPost.js
const crossPost = require('./crossPost');
const crossPostToShopify = crossPost.crossPostToShopify;
const crossPostToWooCommerce = crossPost.crossPostToWooCommerce;
const crossPostToEtsy = crossPost.crossPostToEtsy;


function sanitizeLog(message) {
  return utils.sanitizeLog(message);
}

if (require.main === module) {
  main();
}

module.exports = {
  clusterFilesByTime,
  runAutoListingPipeline,
  sanitizeLog,
  crossPostToShopify,
  crossPostToWooCommerce,
  crossPostToEtsy,
  filterStableFiles
};
