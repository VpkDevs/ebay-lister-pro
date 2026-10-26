/**
 * @file config.js
 * @description Loads environment variables from .env and exposes global configurations with JSDoc typing.
 */

const path = require('path');
const fs = require('fs');

const envPath = path.resolve(process.cwd(), '.env');

// [HARDENING] Persistent state root. All mutable app state (data/ stores and
// the scratch/ billing store) lives under ONE root so a single mounted
// volume keeps billing records and listing history alive across redeploys.
// Point LISTER_STATE_DIR at the volume mount path; on Railway the attached
// volume's RAILWAY_VOLUME_MOUNT_PATH is honored automatically. With neither
// set, the root is the app directory — the exact paths the app has always
// used locally.
const stateRoot = process.env.LISTER_STATE_DIR
  ? path.resolve(process.env.LISTER_STATE_DIR)
  : (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH)
      : process.cwd());
const dataDir = path.join(stateRoot, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const scratchDir = path.join(stateRoot, 'scratch');
if (!fs.existsSync(scratchDir)) {
  fs.mkdirSync(scratchDir, { recursive: true });
}
// [HARDENING] Billing records (who has paid, plans, saved BYOK keys).
const billingDbPath = path.join(scratchDir, 'billing_status.json');

const tempPath = path.join(dataDir, 'temp-listing.json');
const recoveryPath = path.join(dataDir, 'lister-recovery.json');
const logPath = path.join(dataDir, 'lister-audit.log');
const historyPath = path.join(dataDir, 'listings-history.json');
const dlqPath = path.join(dataDir, 'pending-syncs.json');
// [WAVE1-A] Listing templates storage (user-saved reusable field sets).
const templatesPath = path.join(dataDir, 'templates.json');
// [WAVE1-B] Persistent store for user-visible background-task error notifications.
const notificationsPath = path.join(dataDir, 'notifications.json');
// [WAVE1-D] Team seats storage (Power Seller workspaces: owner -> members).
const teamPath = path.join(dataDir, 'team.json');
// [METERING] Per-user monthly AI generation counts ({ billingEmail: { "YYYY-MM": n } }).
const usagePath = path.join(dataDir, 'usage.json');
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
  stateRoot, // [HARDENING]
  dataDir, // [HARDENING]
  scratchDir, // [HARDENING]
  billingDbPath, // [HARDENING]
  tempPath,
  recoveryPath,
  logPath,
  historyPath,
  dlqPath,
  // [WAVE1-A]
  templatesPath,
  notificationsPath, // [WAVE1-B]
  teamPath, // [WAVE1-D]
  usagePath, // [METERING]
  uploadTempDir,
  runDiagnostics,
  /** @returns {string|undefined} */
  getGEMINI_API_KEY: () => process.env.GEMINI_API_KEY,
  /** @returns {string} Gemini model for AI generation. GEMINI_MODEL env override; gemini-2.5-flash is closed to new API users (404). Default is gemini-3.5-flash: gemini-3.8-flash works but intermittently returns 503 (high demand), while 3.5-flash completed reliably in live proof runs. */
  getGEMINI_MODEL: () => (process.env.GEMINI_MODEL || "").trim() || "gemini-3.5-flash",
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
  /** @returns {string|undefined} Operator API key for the Chrome extension.
   * [HARDENING] No shipped default: when API_KEY is not configured there is
   * no API-key identity at all (a configured key or nothing). The previous
   * hardcoded fallback was printed in the public source and authenticated
   * anyone as a premium operator. */
  getAPI_KEY: () => process.env.API_KEY || undefined,
  /** @returns {string|undefined} Public base URL of the deployed app (e.g.
   * https://app.example.com), used for Stripe success/cancel/return URLs.
   * [HARDENING] Checkout no longer hardcodes localhost URLs when this is set. */
  getAPP_URL: () => {
    const url = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
    return url || undefined;
  },
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
  // [WAVE1-C] Discogs personal access token for barcode search on music items.
  /** @returns {string|undefined} */
  getDISCOGS_TOKEN: () => process.env.DISCOGS_TOKEN,
  /** @returns {string[]} */
  getVERO_BRANDS: () => [
    "rolex", "otterbox", "louis vuitton", "gucci", "chanel", "hermes", "prada", 
    "tiffany", "coach", "michael kors", "nike", "adidas", "apple", "bose", 
    "sony", "canon", "nikon", "fitbit", "gopro", "velcro", "zippo", "ugg", 
    "patagonia", "north face", "lululemon", "dyson", "thermomix", "beachbody",
    "moncler", "canada goose", "oakley", "ray-ban"
  ]
};

