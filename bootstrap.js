/**
 * @file bootstrap.js
 * @description Zero-dependency pre-flight checks and interactive environment setup wizard.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

console.log("=========================================================================");
console.log("🚀 eBay Multi-Channel Lister - Bootstrap Configurator Wizard");
console.log("=========================================================================");

// 1. Check Node.js Version
const majorVersion = parseInt(process.versions.node.split('.')[0], 10);
if (majorVersion < 18) {
  console.error(`❌ Error: Node.js version ${process.versions.node} is not supported.`);
  console.error("Minimum required version is Node.js v18.0.0. Please upgrade.");
  process.exit(1);
}
console.log("✔ Node.js version check passed.");

// 2. Check Directory Write Permissions
try {
  const testFile = path.join(__dirname, '.write-test');
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
  console.log("✔ Directory write permissions check passed.");
} catch (err) {
  console.error("❌ Error: No write permission in the current directory.");
  console.error(err.message);
  process.exit(1);
}

// 3. Ensure required subdirectories exist
const subdirs = ['public', 'data', 'data/uploads'];
for (const dir of subdirs) {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
console.log("✔ Directory structure verified.");

// 4. Check if .env already exists
const envPath = path.join(__dirname, '.env');
const examplePath = path.join(__dirname, '.env.example');

if (fs.existsSync(envPath)) {
  console.log("\n⚠️ A '.env' file already exists in this project directory.");
  console.log("If you wish to re-run the configuration wizard, delete or rename your '.env' file.");
  console.log("To run the application, execute: node start.js\n");
  process.exit(0);
}

if (!fs.existsSync(examplePath)) {
  console.error("❌ Error: '.env.example' template file is missing. Cannot proceed.");
  process.exit(1);
}

// 5. Interactive Configuration prompts
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const configValues = {};

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function runWizard() {
  console.log("\nNo '.env' file detected. Let's create one now!");
  console.log("Press [Enter] to accept default values where available.\n");

  // API Key Authentication
  const defaultApiKey = crypto.randomBytes(16).toString('hex');
  const apiKey = await askQuestion(`1. Set Chrome Extension API key [Default: ${defaultApiKey}]: `);
  configValues['API_KEY'] = apiKey.trim() || defaultApiKey;

  // Gemini API Key
  const gemini = await askQuestion("2. Enter Google Gemini API Key (for product flaw detection/specs): ");
  configValues['GEMINI_API_KEY'] = gemini.trim() || "your_gemini_api_key_here";

  // eBay Config
  console.log("\n--- eBay Integration Settings ---");
  const ebayId = await askQuestion("3. Enter eBay Client ID (App ID): ");
  configValues['EBAY_CLIENT_ID'] = ebayId.trim() || "your_ebay_client_id";

  const ebaySecret = await askQuestion("4. Enter eBay Client Secret (Cert ID): ");
  configValues['EBAY_CLIENT_SECRET'] = ebaySecret.trim() || "your_ebay_client_secret";

  const ebayToken = await askQuestion("5. Enter eBay User Refresh Token: ");
  configValues['EBAY_REFRESH_TOKEN'] = ebayToken.trim() || "your_ebay_user_refresh_token";

  // Shopify Config
  console.log("\n--- Shopify Integration Settings (Optional) ---");
  const shopName = await askQuestion("6. Enter Shopify Shop Name (subdomain): ");
  configValues['SHOPIFY_SHOP_NAME'] = shopName.trim();

  const shopToken = await askQuestion("7. Enter Shopify Admin Access Token: ");
  configValues['SHOPIFY_ACCESS_TOKEN'] = shopToken.trim();

  rl.close();

  // Read example template and replace values
  let templateContent = fs.readFileSync(examplePath, 'utf8');

  for (const [key, value] of Object.entries(configValues)) {
    // Regex targeting exact key definition
    const regex = new RegExp(`^${key}\\s*=.*`, 'm');
    if (value) {
      templateContent = templateContent.replace(regex, `${key}=${value}`);
    }
  }

  // Save the new .env file
  fs.writeFileSync(envPath, templateContent, 'utf8');
  console.log("\n=========================================================================");
  console.log("✔ Successful Setup! '.env' configuration file created.");
  console.log("=========================================================================");
  console.log("\n🚀 To start the eBay Multi-Channel Lister, execute:");
  console.log("   node start.js");
  console.log("\n=========================================================================\n");
}

runWizard();
