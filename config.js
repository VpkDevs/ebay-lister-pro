/**
 * @file config.js
 * @description Loads environment variables from .env and exposes global configurations with JSDoc typing.
 */

const path = require('path');
const fs = require('fs');

const envPath = path.resolve(process.cwd(), '.env');

// Establish central data directory for persistence and volume mounting
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const tempPath = path.join(dataDir, 'temp-listing.json');
const recoveryPath = path.join(dataDir, 'lister-recovery.json');
const logPath = path.join(dataDir, 'lister-audit.log');
const historyPath = path.join(dataDir, 'listings-history.json');
const dlqPath = path.join(dataDir, 'pending-syncs.json');
const uploadTempDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadTempDir)) {
  fs.mkdirSync(uploadTempDir, { recursive: true });
}

/**
 * Loads and parses environment variables from the local .env file.
 * @returns {void}
 */
function loadEnv() {
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[key] = value.trim();
      }
    }
  }
}
loadEnv();

/**
 * Runs basic pre-flight verification tests on environment settings.
 * @throws {Error} if Node version or write permissions are invalid.
 * @returns {boolean} true if checks pass, false otherwise.
 */
function runDiagnostics() {
  const versionParts = process.versions.node.split('.');
  const majorVersion = parseInt(versionParts[0], 10);
  if (majorVersion < 18) {
    throw new Error(`Node.js version is ${process.versions.node}. Minimum required version is 18.0.0.`);
  }

  // Verify write permission on working directory by attempting to write a tiny test file
  const testFile = path.join(process.cwd(), '.lister-test-perms');
  try {
    fs.writeFileSync(testFile, 'test', 'utf8');
    fs.unlinkSync(testFile);
  } catch (err) {
    throw new Error(`No write permissions in directory ${process.cwd()}: ${err.message}`);
  }
  return true;
}

module.exports = {
  envPath,
  tempPath,
  recoveryPath,
  logPath,
  historyPath,
  dlqPath,
  uploadTempDir,
  runDiagnostics,
  /** @returns {string|undefined} */
  getGEMINI_API_KEY: () => process.env.GEMINI_API_KEY,
  /** @returns {string|undefined} */
  getEBAY_CLIENT_ID: () => process.env.EBAY_CLIENT_ID,
  /** @returns {string|undefined} */
  getEBAY_CLIENT_SECRET: () => process.env.EBAY_CLIENT_SECRET,
  /** @returns {string|undefined} */
  getEBAY_REFRESH_TOKEN: () => process.env.EBAY_REFRESH_TOKEN,
  /** @returns {string|undefined} */
  getEBAY_RUNAME: () => process.env.EBAY_RUNAME,
  /** @returns {string} */
  getEBAY_LOCATION_KEY: () => process.env.EBAY_LOCATION_KEY || "default",
  /** @returns {string|undefined} */
  getEBAY_FULFILLMENT_POLICY_ID: () => process.env.EBAY_FULFILLMENT_POLICY_ID,
  /** @returns {string|undefined} */
  getEBAY_PAYMENT_POLICY_ID: () => process.env.EBAY_PAYMENT_POLICY_ID,
  /** @returns {string|undefined} */
  getEBAY_RETURN_POLICY_ID: () => process.env.EBAY_RETURN_POLICY_ID,
  /** @returns {string|undefined} */
  getSHOPIFY_SHOP_NAME: () => process.env.SHOPIFY_SHOP_NAME,
  /** @returns {string|undefined} */
  getSHOPIFY_ACCESS_TOKEN: () => process.env.SHOPIFY_ACCESS_TOKEN,
  /** @returns {string} */
  getSELLER_SHIPPING_TERMS: () => process.env.SELLER_SHIPPING_TERMS || "Shipped next business day with tracking!",
  /** @returns {string} */
  getSELLER_RETURN_TERMS: () => process.env.SELLER_RETURN_TERMS || "No returns accepted unless item is not as described.",
  /** @returns {string} */
  getSKU_PREFIX: () => process.env.SKU_PREFIX || "AUTO-",
  /** @returns {string} */
  getDEFAULT_PRICING_STRATEGY: () => process.env.DEFAULT_PRICING_STRATEGY || "MARKET",
  /** @returns {string} */
  getDEFAULT_SHIPPING_OPTION: () => process.env.DEFAULT_SHIPPING_OPTION || "USPS_GROUND",
  /** @returns {string} */
  getDEFAULT_RETURN_OPTION: () => process.env.DEFAULT_RETURN_OPTION || "NO_RETURNS",
  /** @returns {boolean} */
  getDEFAULT_IMMEDIATE_PAYMENT: () => process.env.DEFAULT_IMMEDIATE_PAYMENT !== "false",
  /** @returns {string|undefined} */
  getGOOGLE_CLIENT_ID: () => process.env.GOOGLE_CLIENT_ID,
  /** @returns {string|undefined} */
  getGOOGLE_CLIENT_SECRET: () => process.env.GOOGLE_CLIENT_SECRET,
  /** @returns {string} */
  getGOOGLE_REDIRECT_URI: () => process.env.GOOGLE_REDIRECT_URI || "http://localhost:45911/api/auth/google/callback",
  /** @returns {string|undefined} */
  getSTRIPE_SECRET_KEY: () => process.env.STRIPE_SECRET_KEY,
  /** @returns {string|undefined} */
  getSTRIPE_WEBHOOK_SECRET: () => process.env.STRIPE_WEBHOOK_SECRET,
  /** @returns {string} */
  getAPI_KEY: () => process.env.API_KEY || "lister-secret-key-12345",
  /** @returns {string|undefined} */
  getWOOCOMMERCE_URL: () => {
    const url = process.env.WOOCOMMERCE_URL;
    return url ? url.replace(/\/$/, '') : undefined;
  },
  /** @returns {string|undefined} */
  getWOOCOMMERCE_KEY: () => process.env.WOOCOMMERCE_KEY,
  /** @returns {string|undefined} */
  getWOOCOMMERCE_SECRET: () => process.env.WOOCOMMERCE_SECRET,
  /** @returns {string|undefined} */
  getETSY_SHOP_ID: () => process.env.ETSY_SHOP_ID,
  /** @returns {string|undefined} */
  getETSY_ACCESS_TOKEN: () => process.env.ETSY_ACCESS_TOKEN,
  /** @returns {string|undefined} Etsy Open API key (falls back to EBAY_CLIENT_ID for legacy .env setups) */
  getETSY_CLIENT_ID: () => process.env.ETSY_CLIENT_ID || process.env.EBAY_CLIENT_ID,
  /** @returns {string|undefined} */
  getWATERMARK_TEXT: () => process.env.WATERMARK_TEXT,
  /** @returns {string[]} */
  getVERO_BRANDS: () => [
    "rolex", "otterbox", "louis vuitton", "gucci", "chanel", "hermes", "prada", 
    "tiffany", "coach", "michael kors", "nike", "adidas", "apple", "bose", 
    "sony", "canon", "nikon", "fitbit", "gopro", "velcro", "zippo", "ugg", 
    "patagonia", "north face", "lululemon", "dyson", "thermomix", "beachbody",
    "moncler", "canada goose", "oakley", "ray-ban"
  ]
};

