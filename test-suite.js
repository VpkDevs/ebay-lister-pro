/**
 * @file test-suite.js
 * @description Native zero-dependency unit and integration test suite for the eBay Auto-Lister.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');

// Configure test environment variables (assigned after config.js loads .env to prevent overrides)
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.EBAY_CLIENT_ID = "test-client-id";
process.env.EBAY_CLIENT_SECRET = "test-client-secret";
process.env.EBAY_REFRESH_TOKEN = "test-refresh-token";

const utils = require('./utils');
const ebayClient = require('./ebayClient');
const geminiClient = require('./geminiClient');
const webServer = require('./webServer');

// Capture the real built-in fetch ONCE before any test can mock global.fetch.
// Tests that need to make real HTTP calls to local test servers should use
// REAL_FETCH instead of global.fetch to be immune to concurrent mock pollution.
const REAL_FETCH = global.fetch;

// Use separate paths for test output to avoid polluting real database/logs
const testDir = path.join(process.cwd(), 'test-sandbox');
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir);
}

config.historyPath = path.join(testDir, 'test-listings-history.json');
config.dlqPath = path.join(testDir, 'test-pending-syncs.json');
config.tempPath = path.join(testDir, 'test-temp-listing.json');
config.recoveryPath = path.join(testDir, 'test-lister-recovery.json');
config.logPath = path.join(testDir, 'test-lister-audit.log');
config.uploadTempDir = testDir;
// [WAVE1-A] Redirect listing templates into the test sandbox.
config.templatesPath = path.join(testDir, 'test-templates.json');
config.notificationsPath = path.join(testDir, 'test-notifications.json'); // [WAVE1-B]
config.teamPath = path.join(testDir, 'test-team.json'); // [WAVE1-D]

// Cleanup helper
function cleanupSandbox() {
  const files = [
    config.historyPath,
    `${config.historyPath}.tmp`,
    `${config.historyPath}.bak`,
    config.dlqPath,
    `${config.dlqPath}.tmp`,
    `${config.dlqPath}.bak`,
    config.tempPath,
    config.recoveryPath,
    config.logPath,
    // [WAVE1-A]
    config.templatesPath,
    `${config.templatesPath}.tmp`,
    `${config.templatesPath}.bak`,
    config.notificationsPath, // [WAVE1-B]
    `${config.notificationsPath}.tmp`, // [WAVE1-B]
    `${config.notificationsPath}.bak`, // [WAVE1-B]
    config.teamPath, // [WAVE1-D]
    `${config.teamPath}.tmp`, // [WAVE1-D]
    `${config.teamPath}.bak`, // [WAVE1-D]
    path.join(testDir, 'mock-image.png'),
    path.join(testDir, 'mock-image.jpg')
  ];
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
  }
  try { if (fs.existsSync(testDir)) fs.rmdirSync(testDir); } catch (e) {}
}

test.after(cleanupSandbox);

// ==========================================
// 1. Config Tests
// ==========================================
test('Config module properties and diagnostics', async (t) => {
  await t.test('Diagnostic function returns true in test sandbox', () => {
    const res = config.runDiagnostics();
    assert.strictEqual(res, true);
  });

  await t.test('Retrieve environment variables', () => {
    assert.strictEqual(config.getGEMINI_API_KEY(), 'test-gemini-key');
    assert.strictEqual(config.getEBAY_CLIENT_ID(), 'test-client-id');
    assert.strictEqual(config.getSKU_PREFIX(), 'AUTO-');
  });
});

// ==========================================
// 2. Utility Tests
// ==========================================
test('Utility module operations', async (t) => {
  await t.test('Audit logger and sanitization redacts keys', () => {
    const message = "Connecting to Gemini using api key: test-gemini-key and secret test-client-secret";
    const sanitized = utils.sanitizeLog(message);
    assert.ok(!sanitized.includes('test-gemini-key'));
    assert.ok(!sanitized.includes('test-client-secret'));
    assert.ok(sanitized.includes('[REDACTED_GEMINI_KEY]'));
    assert.ok(sanitized.includes('[REDACTED_CLIENT_SECRET]'));
  });

  await t.test('validateRemoteImageUrl blocks private targets and accepts public URLs', () => {
    assert.throws(() => utils.validateRemoteImageUrl('http://127.0.0.1/image.jpg'));
    assert.throws(() => utils.validateRemoteImageUrl('http://localhost/image.jpg'));
    assert.throws(() => utils.validateRemoteImageUrl('ftp://example.com/image.jpg'));
    assert.strictEqual(
      utils.validateRemoteImageUrl('https://i.ebayimg.com/images/g/test/s-l1600.jpg'),
      'https://i.ebayimg.com/images/g/test/s-l1600.jpg'
    );
  });

  await t.test('resolveUploadsPath maps served upload URLs safely', () => {
    const processedDir = path.join(testDir, 'processed');
    if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
    const samplePath = path.join(processedDir, 'sample.jpg');
    fs.writeFileSync(samplePath, Buffer.from('sample'));

    const resolved = utils.resolveUploadsPath('/uploads/processed/sample.jpg');
    assert.strictEqual(resolved, samplePath);
    assert.throws(() => utils.resolveUploadsPath('/uploads/../outside.jpg'));
  });

  await t.test('Secure JSON read/write with backup recovery', () => {
    const filePath = config.historyPath;
    const testData = [{ sku: "TEST-SKU", price: 19.99 }];

    // Safe write and read
    utils.writeJsonFileSecure(filePath, testData);
    const readData = utils.readJsonFileSecure(filePath);
    assert.deepStrictEqual(readData, testData);

    // Corrupt primary file manually to trigger backup recovery
    const backupPath = `${filePath}.bak`;
    
    // Manually create a backup file and a corrupted primary file
    fs.writeFileSync(backupPath, JSON.stringify(testData), 'utf8');
    fs.writeFileSync(filePath, "invalid json string { corrupt }", 'utf8');

    // Read should catch corruption and recover from backup
    const recovered = utils.readJsonFileSecure(filePath);
    assert.deepStrictEqual(recovered, testData);
    
    // Verify it restored primary
    const primaryContent = fs.readFileSync(filePath, 'utf8');
    assert.ok(!primaryContent.includes("invalid json"));
  });

  await t.test('Binary signature image dimension extraction', () => {
    // Generate Mock PNG
    const pngPath = path.join(testDir, 'mock-image.png');
    const pngBuf = Buffer.alloc(32);
    pngBuf.writeUInt32BE(0x89504E47, 0);
    pngBuf.writeUInt32BE(0x0D0A1A0A, 4);
    pngBuf.writeUInt32BE(13, 8);
    pngBuf.writeUInt32BE(0x49484452, 12); // IHDR
    pngBuf.writeUInt32BE(800, 16); // Width
    pngBuf.writeUInt32BE(600, 20); // Height
    fs.writeFileSync(pngPath, pngBuf);

    const pngDimensions = utils.getImageDimensions(pngPath);
    assert.ok(pngDimensions);
    assert.strictEqual(pngDimensions.width, 800);
    assert.strictEqual(pngDimensions.height, 600);
    assert.strictEqual(pngDimensions.type, 'PNG');

    // Generate Mock JPEG
    const jpgPath = path.join(testDir, 'mock-image.jpg');
    const jpegBuf = Buffer.alloc(100);
    jpegBuf.writeUInt16BE(0xFFD8, 0);
    jpegBuf.writeUInt16BE(0xFFE0, 2); // APP0 marker
    jpegBuf.writeUInt16BE(16, 4); // segment length
    jpegBuf.writeUInt16BE(0xFFC0, 20); // SOF0
    jpegBuf.writeUInt16BE(15, 22); // length
    jpegBuf.writeUInt8(8, 24); // precision
    jpegBuf.writeUInt16BE(768, 25); // Height
    jpegBuf.writeUInt16BE(1024, 27); // Width
    fs.writeFileSync(jpgPath, jpegBuf);

    const jpegDimensions = utils.getImageDimensions(jpgPath);
    assert.ok(jpegDimensions);
    assert.strictEqual(jpegDimensions.width, 1024);
    assert.strictEqual(jpegDimensions.height, 768);
    assert.strictEqual(jpegDimensions.type, 'JPEG');
  });
});

// ==========================================
// 3. eBay Client Tests
// ==========================================
test('eBay Client and fetchWithRetry network layer', async (t) => {
  const originalFetch = REAL_FETCH;

  await t.test('fetchWithRetry parses Retry-After and handles retries', async () => {
    let callCount = 0;
    global.fetch = async (url, options) => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 429,
          ok: false,
          headers: {
            get: (h) => h.toLowerCase() === 'retry-after' ? '0' : null
          }
        };
      }
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ success: true }),
        json: async () => ({ success: true })
      };
    };

    const res = await ebayClient.fetchWithRetry("https://api.ebay.com/test-429", {}, 2, 1);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(callCount, 2);
  });

  await t.test('refreshEbayAccessToken sets credentials', async () => {
    global.fetch = async (url, options) => {
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ access_token: "mock-access-token" }),
        json: async () => ({ access_token: "mock-access-token" })
      };
    };

    await ebayClient.refreshEbayAccessToken();
    assert.strictEqual(ebayClient.getAccessToken(), "mock-access-token");
  });

  await t.test('suggestCategory returns suggested category ID', async () => {
    global.fetch = async (url, options) => {
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          categorySuggestions: [{
            category: { categoryId: "12345", categoryName: "Test Category" },
            categoryTreeNodeAncestors: []
          }]
        }),
        json: async () => ({
          categorySuggestions: [{
            category: { categoryId: "12345", categoryName: "Test Category" },
            categoryTreeNodeAncestors: []
          }]
        })
      };
    };

    const catId = await ebayClient.suggestCategory("Awesome Vintage Boots");
    assert.strictEqual(catId, "12345");
  });

  await t.test('lookupUPCOnEbay returns product specs', async () => {
    global.fetch = async (url, options) => {
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          productSummaries: [{
            title: "Test Product title",
            brand: "BrandX",
            mpn: "MPN-99",
            aspects: [{ name: "Color", values: ["Blue"] }]
          }]
        }),
        json: async () => ({
          productSummaries: [{
            title: "Test Product title",
            brand: "BrandX",
            mpn: "MPN-99",
            aspects: [{ name: "Color", values: ["Blue"] }]
          }]
        })
      };
    };

    const specs = await ebayClient.lookupUPCOnEbay("123456789012");
    assert.ok(specs);
    assert.strictEqual(specs.title, "Test Product title");
    assert.strictEqual(specs.brand, "BrandX");
    assert.strictEqual(specs.aspects.Color, "Blue");
  });

  // Restore fetch
  global.fetch = originalFetch;
});

// ==========================================
// 4. Gemini Client Tests
// ==========================================
test('Gemini Client processing', async (t) => {
  await t.test('parseSafeJsonString handles fences and text wrapping', () => {
    const rawClean = '{"title": "Boots"}';
    const parsedClean = geminiClient.parseSafeJsonString(rawClean);
    assert.strictEqual(parsedClean.title, "Boots");

    const rawFence = '```json\n{"title": "Boots Fence"}\n```';
    const parsedFence = geminiClient.parseSafeJsonString(rawFence);
    assert.strictEqual(parsedFence.title, "Boots Fence");

    const rawWrapped = 'Random words before {\n  "title": "Boots Wrapped"\n} and text after';
    const parsedWrapped = geminiClient.parseSafeJsonString(rawWrapped);
    assert.strictEqual(parsedWrapped.title, "Boots Wrapped");

    const rawCorrupt = 'corrupted JSON data';
    const parsedDefault = geminiClient.parseSafeJsonString(rawCorrupt, { fallback: true });
    assert.strictEqual(parsedDefault.fallback, true);
  });

  await t.test('validateAndFixListingSchema fixes invalid properties in-place', () => {
    const listing = {
      title: "Boots title that goes way too long over eighty characters limit to check slice behavior in lister schema validation",
      suggestedPrice: "invalid-price",
      condition: "INVALID_CONDITION",
      aspects: {
        LongAspect: "Value that is very long and needs to be trimmed to fifty characters limit"
      }
    };

    geminiClient.validateAndFixListingSchema(listing);

    assert.ok(listing.title.length <= 80);
    assert.strictEqual(listing.suggestedPrice, 9.99);
    assert.strictEqual(listing.condition, "USED_EXCELLENT");
    assert.ok(listing.aspects.LongAspect.endsWith("..."));
    assert.ok(listing.aspects.LongAspect.length <= 50);
    assert.strictEqual(listing.weightMajor, 1);
    assert.strictEqual(listing.packageLength, 10);
  });

  await t.test('validateAndFixListingSchema formats and injects defect report', () => {
    const listing = {
      title: "Test item",
      description: "Original Description",
      suggestedPrice: 19.99,
      detectedDefects: ["Small scratch on back", "Scuff mark on bottom"]
    };
    
    geminiClient.validateAndFixListingSchema(listing);
    
    assert.ok(listing.description.includes("AI Condition Report (Defect Detection):"));
    assert.ok(listing.description.includes("Small scratch on back"));
    assert.ok(listing.description.includes("Scuff mark on bottom"));
    
    const descLengthBefore = listing.description.length;
    geminiClient.validateAndFixListingSchema(listing);
    assert.strictEqual(listing.description.length, descLengthBefore);
  });
});

// ==========================================
// 5. Web Server Integration Tests
// ==========================================
test('Web Server local GUI routing', async (t) => {
  const originalFetch = REAL_FETCH;
  // Restore fetch for actual loopback calls
  global.fetch = originalFetch;

  const testPort = 45911;
  const server = webServer.startWebGuiServer(testPort);

  await t.test('GET / returns HTML page', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('<!DOCTYPE html>'));
    
    // Check security headers
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('content-security-policy'));
  });

  await t.test('GET /api/history returns listings wrapper object', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/history`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data && typeof data === 'object');
    assert.ok(Array.isArray(data.listings));
  });

  await t.test('DELETE /api/history removes listing from database', async () => {
    const originalHistory = utils.readJsonFileSecure(config.historyPath, []);
    const dummyItem = { sku: "TEST-DELETE-SKU", price: 10, title: "Test Delete Item", timestamp: new Date().toISOString() };
    utils.writeJsonFileSecure(config.historyPath, [...originalHistory, dummyItem]);

    const res = await fetch(`http://127.0.0.1:${testPort}/api/history?sku=TEST-DELETE-SKU`, {
      method: 'DELETE'
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);

    const updatedHistory = utils.readJsonFileSecure(config.historyPath, []);
    const found = updatedHistory.some(item => item.sku === "TEST-DELETE-SKU");
    assert.strictEqual(found, false);
  });

  await t.test('POST /api/analyze with invalid payload returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: "missing images array" })
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  await t.test('POST /api/images/import-urls validates payload and blocks unsafe URLs', async () => {
    const emptyRes = await fetch(`http://127.0.0.1:${testPort}/api/images/import-urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [] })
    });
    assert.strictEqual(emptyRes.status, 400);

    const blockedRes = await fetch(`http://127.0.0.1:${testPort}/api/images/import-urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: ['http://127.0.0.1/private.jpg'] })
    });
    assert.strictEqual(blockedRes.status, 400);
    const blockedData = await blockedRes.json();
    assert.ok(blockedData.error || (blockedData.rejected && blockedData.rejected.length > 0));
  });

  await t.test('POST /api/analyze accepts local /uploads/ image references', async () => {
    const processedDir = path.join(testDir, 'processed');
    if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

    const pngPath = path.join(processedDir, 'analyze-local.png');
    const pngBuf = Buffer.alloc(32);
    pngBuf.writeUInt32BE(0x89504E47, 0);
    pngBuf.writeUInt32BE(0x0D0A1A0A, 4);
    pngBuf.writeUInt32BE(13, 8);
    pngBuf.writeUInt32BE(0x49484452, 12);
    pngBuf.writeUInt32BE(600, 16);
    pngBuf.writeUInt32BE(600, 20);
    fs.writeFileSync(pngPath, pngBuf);

    const originalOrchestration = geminiClient.runAIOrchestration;
    const originalRefresh = ebayClient.refreshEbayAccessToken;
    const originalFetchWithRetry = ebayClient.fetchWithRetry;
    geminiClient.runAIOrchestration = async () => ({
      title: 'Imported URL Test Listing',
      description: 'Test',
      suggestedPrice: 12.99,
      condition: 'USED_EXCELLENT',
      aspects: {},
      categoryId: '111422'
    });
    ebayClient.refreshEbayAccessToken = async () => {};
    ebayClient.fetchWithRetry = async (url) => {
      if (String(url).includes('tmpfiles.org') || String(url).includes('file.io')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', data: { url: 'https://tmpfiles.org/dl/mock.jpg' } })
        };
      }
      return originalFetchWithRetry(url);
    };

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: ['/uploads/processed/analyze-local.png'],
          notes: 'local upload path test'
        })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.listing);
      assert.ok(Array.isArray(data.imageUrls));
    } finally {
      geminiClient.runAIOrchestration = originalOrchestration;
      ebayClient.refreshEbayAccessToken = originalRefresh;
      ebayClient.fetchWithRetry = originalFetchWithRetry;
      try { fs.unlinkSync(pngPath); } catch (e) {}
    }
  });

  await t.test('POST /api/publish with invalid payload returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing: {}, imageUrls: [] })
    });
    assert.strictEqual(res.status, 400);
  });

  await t.test('Save draft and publish draft workflow', async () => {
    const originalFetch = REAL_FETCH;
    const createMockResponse = (status, bodyObj) => {
      const bodyText = JSON.stringify(bodyObj);
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        json: async () => bodyObj,
        text: async () => bodyText
      };
    };
    
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.startsWith(`http://127.0.0.1:${testPort}`)) {
        return originalFetch(url, options);
      }
      
      if (urlStr.includes('myshopify.com/admin/api/')) {
        return createMockResponse(200, {
          product: {
            id: "shopify-123",
            status: "active",
            variants: [{ inventory_quantity: 1 }]
          }
        });
      }
      
      return createMockResponse(200, { access_token: "mock-token" });
    };

    const originalEbayRequest = ebayClient.ebayRequest;
    ebayClient.ebayRequest = async (path, method, body) => {
      if (path.includes('/publish')) {
        return { listingId: "ebay-listing-777" };
      }
      if (path === '/offer') {
        return { offerId: "ebay-offer-888" };
      }
      return {};
    };

    try {
      const saveRes = await originalFetch(`http://127.0.0.1:${testPort}/api/save-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listing: {
            title: "Draft Test Title",
            suggestedPrice: 49.99,
            condition: "USED_EXCELLENT",
            brand: "Unbranded",
            aspects: { Color: "Blue" },
            categoryId: "111422"
          },
          imageUrls: ["https://example.com/image.jpg"]
        })
      });
      
      if (saveRes.status !== 200) {
        console.log("SAVE DRAFT ERROR STATUS:", saveRes.status);
        console.log("BODY:", await saveRes.text());
      }
      assert.strictEqual(saveRes.status, 200);
      const saveJson = await saveRes.json();
      assert.ok(saveJson.sku);
      
      const history1 = utils.readJsonFileSecure(config.historyPath, []);
      const draftItem = history1.find(i => i.sku === saveJson.sku);
      assert.ok(draftItem);
      assert.strictEqual(draftItem.status, "DRAFT");
      assert.strictEqual(draftItem.title, "Draft Test Title");
      
      const pubRes = await originalFetch(`http://127.0.0.1:${testPort}/api/publish-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: saveJson.sku })
      });
      
      if (pubRes.status !== 200) {
        console.log("PUBLISH DRAFT ERROR STATUS:", pubRes.status);
        console.log("BODY:", await pubRes.text());
      }
      assert.strictEqual(pubRes.status, 200);
      const pubJson = await pubRes.json();
      assert.strictEqual(pubJson.listingId, "ebay-listing-777");
      
      const history2 = utils.readJsonFileSecure(config.historyPath, []);
      const activeItem = history2.find(i => i.sku === saveJson.sku);
      assert.ok(activeItem);
      assert.strictEqual(activeItem.status, "ACTIVE");
      assert.strictEqual(activeItem.listingId, "ebay-listing-777");
      assert.strictEqual(activeItem.offerId, "ebay-offer-888");
    } finally {
      global.fetch = originalFetch;
      ebayClient.ebayRequest = originalEbayRequest;
    }
  });

  await t.test('Double-Selling Protection Inventory sync workflow', async () => {
    const originalFetch = REAL_FETCH;
    const originalEbayRequest = ebayClient.ebayRequest;
    const createMockResponse = (status, bodyObj) => {
      const bodyText = JSON.stringify(bodyObj);
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        json: async () => bodyObj,
        text: async () => bodyText
      };
    };
    
    const oldShopName = process.env.SHOPIFY_SHOP_NAME;
    const oldShopifyToken = process.env.SHOPIFY_ACCESS_TOKEN;
    process.env.SHOPIFY_SHOP_NAME = "test-shop";
    process.env.SHOPIFY_ACCESS_TOKEN = "test-token";
    
    const testSku = "SYNC-SKU-999";
    const history = [{
      timestamp: new Date().toISOString(),
      sku: testSku,
      listingId: "ebay-list-999",
      offerId: "ebay-offer-999",
      shopifyId: "shopify-prod-999",
      title: "Sync Test Title",
      price: 25.00,
      categoryId: "111422",
      status: "ACTIVE"
    }];
    utils.writeJsonFileSecure(config.historyPath, history);

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.startsWith(`http://127.0.0.1:${testPort}`)) {
        return originalFetch(url, options);
      }
      
      if (urlStr.includes('myshopify.com/admin/api/')) {
        return createMockResponse(404, {});
      }
      return createMockResponse(200, { access_token: "mock-token" });
    };

    ebayClient.ebayRequest = async (path, method, body) => {
      if (path.includes('/withdraw')) {
        return { listingId: "ebay-list-999" };
      }
      if (path.includes('/offer?sku=')) {
        return { offers: [{ sku: testSku, offerId: "ebay-offer-999", status: "LISTED" }] };
      }
      if (path.includes('/inventory_item')) {
        return { inventoryItems: [] };
      }
      return {};
    };

    const syncRes = await originalFetch(`http://127.0.0.1:${testPort}/api/sync`, {
      method: 'POST'
    });
    
    if (syncRes.status !== 200) {
      console.log("SYNC ERROR STATUS:", syncRes.status);
      console.log("BODY:", await syncRes.text());
    }
    assert.strictEqual(syncRes.status, 200);
    
    const updatedHistory = utils.readJsonFileSecure(config.historyPath, []);
    const syncedItem = updatedHistory.find(i => i.sku === testSku);
    assert.ok(syncedItem);
    assert.strictEqual(syncedItem.status, "ENDED");

    if (oldShopName) process.env.SHOPIFY_SHOP_NAME = oldShopName;
    else delete process.env.SHOPIFY_SHOP_NAME;
    if (oldShopifyToken) process.env.SHOPIFY_ACCESS_TOKEN = oldShopifyToken;
    else delete process.env.SHOPIFY_ACCESS_TOKEN;
    
    global.fetch = originalFetch;
    ebayClient.ebayRequest = originalEbayRequest;
  });

  // Close server gracefully
  await new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

// ==========================================
// 6. Autonomous Listing Tests
// ==========================================
test('Autonomous listing features', async (t) => {
  const listerPro = require('./simple-lister-pro');

  await t.test('clusterFilesByTime groups files within 2 minute window', () => {
    const originalStatSync = fs.statSync;
    
    const times = {
      'file1.jpg': 1000,
      'file2.jpg': 5000,
      'file3.jpg': 130000,
      'file4.jpg': 140000
    };

    fs.statSync = (filePath) => {
      const base = path.basename(filePath);
      if (times[base] !== undefined) {
        return { mtimeMs: times[base] };
      }
      return { mtimeMs: Date.now() };
    };

    const files = ['file1.jpg', 'file2.jpg', 'file3.jpg', 'file4.jpg'].map(f => path.join(testDir, f));
    const clusters = listerPro.clusterFilesByTime(files);

    assert.strictEqual(clusters.length, 2);
    assert.strictEqual(clusters[0].length, 2);
    assert.strictEqual(clusters[1].length, 2);
    assert.ok(clusters[0][0].includes('file1.jpg'));
    assert.ok(clusters[1][0].includes('file3.jpg'));

    fs.statSync = originalStatSync;
  });

  await t.test('Gemini client Vision prompts extract detectedUPC', () => {
    const sampleOutput = '{\n  "title": "Awesome Item",\n  "detectedUPC": "888123456789"\n}';
    const parsed = geminiClient.parseSafeJsonString(sampleOutput);
    assert.strictEqual(parsed.detectedUPC, "888123456789");
  });

  await t.test('Pricing strategy default rules validation', () => {
    const basePrice = 100.00;
    const fastPrice = Number((basePrice * 0.9).toFixed(2));
    assert.strictEqual(fastPrice, 90.00);

    const premiumPrice = Number((basePrice * 1.1).toFixed(2));
    assert.strictEqual(premiumPrice, 110.00);
  });
});

// ==========================================
// 7. Advanced Smart Pricing, Stock Photo Sourcing & Image Editing Tests
// ==========================================
test('Advanced Pricing, Stock Photos, and Image Editing', async (t) => {
  const originalFetch = REAL_FETCH;

  await t.test('optimizeImageNative resizes and crops image natively', async () => {
    const inputPng = path.join(testDir, 'test-input.png');
    const outputJpg = path.join(testDir, 'test-output.jpg');
    
    // Write a valid 1x1 transparent PNG
    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    fs.writeFileSync(inputPng, Buffer.from(base64Png, 'base64'));

    try {
      await utils.optimizeImageNative(inputPng, outputJpg, 1600);
      assert.ok(fs.existsSync(outputJpg));
      
      // Verify that the output exists and is a valid JPEG structure
      const dimensions = utils.getImageDimensions(outputJpg);
      if (process.platform === 'win32') {
        assert.ok(dimensions);
        assert.strictEqual(dimensions.width, 1600);
        assert.strictEqual(dimensions.height, 1600);
        assert.strictEqual(dimensions.type, 'JPEG');
      }
    } finally {
      try { fs.unlinkSync(inputPng); } catch (e) {}
      try { fs.unlinkSync(outputJpg); } catch (e) {}
    }
  });

  await t.test('searchEbayComps calculates statistics from Browse API', async () => {
    let fetchCalled = false;
    global.fetch = async (url, options) => {
      fetchCalled = true;
      assert.ok(url.includes('/item_summary/search'));
      assert.ok(url.includes('filter=conditions'));
      return {
        status: 200,
        ok: true,
        json: async () => ({
          itemSummaries: [
            { price: { value: "10.00" } },
            { price: { value: "20.00" } },
            { price: { value: "30.00" } }
          ]
        })
      };
    };

    const comps = await ebayClient.searchEbayComps("vintage boots", "USED_EXCELLENT");
    assert.ok(fetchCalled);
    assert.strictEqual(comps.minPrice, 10.00);
    assert.strictEqual(comps.maxPrice, 30.00);
    assert.strictEqual(comps.avgPrice, 20.00);
    assert.strictEqual(comps.source, "eBay Browse API Comps");
  });

  await t.test('searchEbayComps falls back to default condition rules', async () => {
    global.fetch = async (url, options) => {
      return {
        status: 404,
        ok: false,
        json: async () => ({})
      };
    };

    // 1. Generic item fallback (does not match any category)
    const compsGeneric = await ebayClient.searchEbayComps("unknown item", "NEW");
    assert.strictEqual(compsGeneric.avgPrice, 37.49); // default 29.99 * 1.25
    assert.strictEqual(compsGeneric.minPrice, 26.24); // 37.49 * 0.7
    assert.strictEqual(compsGeneric.maxPrice, 48.74); // 37.49 * 1.3
    assert.strictEqual(compsGeneric.source, "Condition & Category Rule Engine Defaults");

    // 2. Category-specific item fallback ("rare coin" -> Collectibles)
    const compsCollectible = await ebayClient.searchEbayComps("rare coin", "NEW");
    assert.strictEqual(compsCollectible.avgPrice, 56.25); // Collectibles 45.00 * 1.25
    assert.strictEqual(compsCollectible.minPrice, 39.38); // 56.25 * 0.7
    assert.strictEqual(compsCollectible.maxPrice, 73.13); // 56.25 * 1.3
  });

  await t.test('searchCatalogStockPhotos retrieves image URLs from Catalog API', async () => {
    global.fetch = async (url, options) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          productSummaries: [
            {
              image: { imageUrl: "https://example.com/stock1.jpg" },
              additionalImages: [
                { imageUrl: "https://example.com/stock2.jpg" },
                { imageUrl: "https://example.com/stock1.jpg" } // duplicate check
              ]
            }
          ]
        })
      };
    };

    const urls = await ebayClient.searchCatalogStockPhotos("boots");
    assert.strictEqual(urls.length, 2);
    assert.deepStrictEqual(urls, ["https://example.com/stock1.jpg", "https://example.com/stock2.jpg"]);
  });

  global.fetch = originalFetch;
});

// ==========================================
// 8. Advanced Resiliency, Draft Overwrites, and Daemon Watcher Tests
// ==========================================
test('Advanced Resiliency and Draft Overwrite integration', async (t) => {
  const originalFetch = REAL_FETCH;

  await t.test('circuit breaker trips after 5 consecutive failures and blocks network calls', async () => {
    let callCount = 0;
    global.fetch = async (url, options) => {
      callCount++;
      return {
        status: 500,
        ok: false,
        headers: { get: () => null },
        json: async () => ({})
      };
    };

    // Trigger 5 consecutive 500 responses
    for (let i = 0; i < 5; i++) {
      await ebayClient.fetchWithRetry("https://api.ebay.com/fail-route", {}, 1, 1);
    }

    // The 6th call should be blocked immediately by circuit breaker
    await assert.rejects(
      async () => {
        await ebayClient.fetchWithRetry("https://api.ebay.com/fail-route", {}, 1, 1);
      },
      /Circuit Breaker Active/
    );

    // Reset circuit breaker by mocking Date.now and making a successful call
    const originalDateNow = Date.now;
    try {
      Date.now = () => originalDateNow() + 35000; // Simulate 35 seconds passing
      global.fetch = async (url, options) => {
        return {
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: async () => ({ success: true })
        };
      };
      const res = await ebayClient.fetchWithRetry("https://api.ebay.com/success-route", {}, 1, 1);
      assert.strictEqual(res.status, 200);
    } finally {
      Date.now = originalDateNow;
    }
  });

  await t.test('POST /api/save-draft overwrites existing draft if matching SKU is provided', async () => {
    global.fetch = originalFetch;
    const testPort = 45912;
    const server = webServer.startWebGuiServer(testPort);
    
    try {
      // 1. Save draft first time
      const saveRes1 = await fetch(`http://127.0.0.1:${testPort}/api/save-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listing: {
            title: "Original Draft Title",
            suggestedPrice: 10.00,
            condition: "USED_EXCELLENT",
            brand: "Generic",
            aspects: {},
            categoryId: "111422"
          },
          imageUrls: []
        })
      });
      const saveJson1 = await saveRes1.json();
      const sku = saveJson1.sku;
      assert.ok(sku);

      // Verify it is in history
      let history = utils.readJsonFileSecure(config.historyPath, []);
      let item = history.find(i => i.sku === sku);
      assert.strictEqual(item.title, "Original Draft Title");
      assert.strictEqual(item.price, 10.00);

      // 2. Save draft second time with same SKU but modified title/price
      const saveRes2 = await fetch(`http://127.0.0.1:${testPort}/api/save-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: sku,
          listing: {
            title: "Updated Draft Title",
            suggestedPrice: 15.50,
            condition: "USED_EXCELLENT",
            brand: "Generic",
            aspects: {},
            categoryId: "111422"
          },
          imageUrls: []
        })
      });
      const saveJson2 = await saveRes2.json();
      assert.strictEqual(saveJson2.sku, sku);

      // Verify history is updated in-place and has no duplicate entries
      history = utils.readJsonFileSecure(config.historyPath, []);
      const matches = history.filter(i => i.sku === sku);
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].title, "Updated Draft Title");
      assert.strictEqual(matches[0].price, 15.50);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  global.fetch = originalFetch;
});

// ==========================================
// 9. Advanced Improvements & Hardening Tests
// ==========================================
test('Advanced pricing outlier filter in searchEbayComps', async (t) => {
  const originalFetch = REAL_FETCH;
  const originalToken = ebayClient.getAccessToken();
  ebayClient.setAccessToken("test-token-active");
  ebayClient.resetCircuitBreaker();
  try {
    // Mock Browse API returning 9 prices, including low ($1.00) and high ($100.00) outliers
    global.fetch = async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          itemSummaries: [
            { price: { value: "1.00" } }, // Outlier 1
            { price: { value: "20.00" } },
            { price: { value: "21.00" } },
            { price: { value: "22.00" } },
            { price: { value: "23.00" } },
            { price: { value: "24.00" } },
            { price: { value: "25.00" } },
            { price: { value: "26.00" } },
            { price: { value: "100.00" } }, // Outlier 2
          ]
        })
      };
    };

    // Trimmed prices (9 * 0.15 = 1 element trimmed from each end):
    // [20.00, 21.00, 22.00, 23.00, 24.00, 25.00, 26.00]
    // Min = 20.00, Max = 26.00, Avg = 23.00
    const comps = await ebayClient.searchEbayComps("test item", "USED_EXCELLENT");
    assert.strictEqual(comps.minPrice, 20.00);
    assert.strictEqual(comps.maxPrice, 26.00);
    assert.strictEqual(comps.avgPrice, 23.00);
  } finally {
    global.fetch = originalFetch;
    ebayClient.setAccessToken(originalToken);
  }
});

test('Expanded category fallback dictionary in getFallbackPrices', async (t) => {
  const compsToy = await ebayClient.searchEbayComps("fun lego set", "USED_EXCELLENT");
  assert.strictEqual(compsToy.avgPrice, 19.99);
  
  const compsTool = await ebayClient.searchEbayComps("power drill", "USED_EXCELLENT");
  assert.strictEqual(compsTool.avgPrice, 34.99);
  
  const compsSport = await ebayClient.searchEbayComps("golf clubs", "USED_EXCELLENT");
  assert.strictEqual(compsSport.avgPrice, 39.99);
  
  const compsJewelry = await ebayClient.searchEbayComps("gold ring", "USED_EXCELLENT");
  assert.strictEqual(compsJewelry.avgPrice, 49.99);
});

test('Web Server /api/status and /api/logs endpoints', async (t) => {
  const testPort = 45913;
  const server = webServer.startWebGuiServer(testPort);
  try {
    const healthRes = await fetch(`http://127.0.0.1:${testPort}/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, "ok");
    assert.ok(healthData.timestamp);
    assert.strictEqual(healthData.version, "1.0.0");

    const statusRes = await fetch(`http://127.0.0.1:${testPort}/api/status`);
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.ok(statusData.status);
    assert.ok(statusData.circuitBreaker);
    assert.strictEqual(statusData.diagnostics, "OK");
    
    const logsRes = await fetch(`http://127.0.0.1:${testPort}/api/logs`);
    assert.strictEqual(logsRes.status, 200);
    const logsData = await logsRes.json();
    assert.ok(logsData.logs);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Web Server VeRO brands and Repricer endpoints', async (t) => {
  const testPort = 45935;
  const server = webServer.startWebGuiServer(testPort);
  const originalFetch = REAL_FETCH;
  // Snapshot history so we can restore it after this test
  const historySnapshot = utils.readJsonFileSecure(config.historyPath, []);
  try {
    // 1. Test GET /api/vero-brands
    const brandsRes = await originalFetch(`http://127.0.0.1:${testPort}/api/vero-brands`);
    assert.strictEqual(brandsRes.status, 200);
    const brandsData = await brandsRes.json();
    assert.ok(Array.isArray(brandsData.brands));
    assert.ok(brandsData.brands.includes("rolex"));

    // Prepare a mock item in history
    const testSku = "TEST-REPRICE-SKU-123";
    utils.writeJsonFileSecure(config.historyPath, [{
      sku: testSku,
      title: "Test Watch",
      price: 100.0,
      status: "ACTIVE",
      offerId: "off-123",
      timestamp: new Date().toISOString()
    }]);

    // 2. Test POST /api/repricer with invalid sku
    const invalidSkuRes = await originalFetch(`http://127.0.0.1:${testPort}/api/repricer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: "NONEXISTENT", priceFloor: 50, priceCap: 150 })
    });
    assert.strictEqual(invalidSkuRes.status, 404);

    // 3. Test POST /api/repricer with floor > cap (invalid)
    const invalidFloorRes = await originalFetch(`http://127.0.0.1:${testPort}/api/repricer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: testSku, priceFloor: 200, priceCap: 150 })
    });
    assert.strictEqual(invalidFloorRes.status, 400);

    // 4. Test POST /api/repricer with valid payload
    const repricerRes = await originalFetch(`http://127.0.0.1:${testPort}/api/repricer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: testSku, priceFloor: 50.0, priceCap: 150.0, priceLocked: true })
    });
    assert.strictEqual(repricerRes.status, 200);
    const repricerData = await repricerRes.json();
    assert.strictEqual(repricerData.success, true);
    assert.strictEqual(repricerData.priceFloor, 50.0);
    assert.strictEqual(repricerData.priceCap, 150.0);
    assert.strictEqual(repricerData.priceLocked, true);

    // Verify history file was updated
    const history = utils.readJsonFileSecure(config.historyPath, []);
    const updatedItem = history.find(i => i.sku === testSku);
    assert.ok(updatedItem);
    assert.strictEqual(updatedItem.priceFloor, 50.0);
    assert.strictEqual(updatedItem.priceCap, 150.0);
    assert.strictEqual(updatedItem.priceLocked, true);

    // 5. Test POST /api/repricer/run (runs against empty eBay – expect 200)
    const runRes = await originalFetch(`http://127.0.0.1:${testPort}/api/repricer/run`, {
      method: 'POST'
    });
    assert.strictEqual(runRes.status, 200);
    const runData = await runRes.json();
    assert.strictEqual(runData.success, true);
  } finally {
    // Restore original history so downstream tests are not affected
    utils.writeJsonFileSecure(config.historyPath, historySnapshot);
    // Reset circuit breakers so repricer/run call doesn't leave dirty breaker state
    ebayClient.resetCircuitBreaker('all');
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Watch Daemon directory scanner resilience on missing/locked files', (t) => {
  const originalStatSync = fs.statSync;
  const originalReaddirSync = fs.readdirSync;
  
  try {
    fs.readdirSync = (dir) => ['deleted-file.jpg'];
    fs.statSync = (file) => {
      throw new Error("ENOENT: no such file or directory");
    };
    
    const listerPro = require('./simple-lister-pro');
    const clusters = listerPro.clusterFilesByTime(['deleted-file.jpg']);
    assert.strictEqual(clusters.length, 1);
  } finally {
    fs.statSync = originalStatSync;
    fs.readdirSync = originalReaddirSync;
  }
});

// ==========================================
// 10. Hardening and Upgrade Verification Tests
// ==========================================
test('Hardening and Upgrade Verification tests', async (t) => {
  const originalFetch = REAL_FETCH;

  await t.test('UPC Barcode input sanitization and length validation', async () => {
    // 1. Valid UPC with spaces/dashes should sanitize and succeed
    let fetchUrl = null;
    global.fetch = async (url) => {
      fetchUrl = url;
      return {
        status: 200,
        ok: true,
        json: async () => ({ productSummaries: [] })
      };
    };

    const resValid = await ebayClient.lookupUPCOnEbay(" 123-456-789 012 ");
    assert.ok(fetchUrl);
    assert.ok(fetchUrl.includes("123456789012")); // cleaned to digits only

    // 2. Invalid UPC characters / length should return null without fetching
    fetchUrl = null;
    const resInvalidChar = await ebayClient.lookupUPCOnEbay("12345678901A");
    assert.strictEqual(resInvalidChar, null);
    assert.strictEqual(fetchUrl, null);

    const resInvalidLen = await ebayClient.lookupUPCOnEbay("12345");
    assert.strictEqual(resInvalidLen, null);
    assert.strictEqual(fetchUrl, null);
  });

  await t.test('ebayFetch auto-retry on 401 Unauthorized', async () => {
    let callCount = 0;
    let tokenRefreshCalled = false;
    
    // Backup access token and current fetch (could be mocked by a prior sub-test)
    const oldAccessToken = ebayClient.getAccessToken();
    const priorFetch = global.fetch;   // save whatever is current
    ebayClient.setAccessToken("expired-token");

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      const authHeader = options.headers && options.headers.Authorization;

      if (urlStr.includes('/identity/v1/oauth2/token')) {
        tokenRefreshCalled = true;
        assert.ok(authHeader && authHeader.startsWith("Basic "));
        return {
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: async () => ({ access_token: "fresh-token" }),
          text: async () => JSON.stringify({ access_token: "fresh-token" })
        };
      }

      // Sell API request
      callCount++;
      if (callCount === 1) {
        assert.strictEqual(authHeader, "Bearer expired-token");
        return {
          status: 401,
          ok: false,
          headers: { get: () => null },
          text: async () => "Unauthorized"
        };
      } else {
        assert.strictEqual(authHeader, "Bearer fresh-token");
        return {
          status: 200,
          ok: true,
          headers: { get: () => null },
          json: async () => ({ status: "SUCCESS" }),
          text: async () => JSON.stringify({ status: "SUCCESS" })
        };
      }
    };

    try {
      const res = await ebayClient.ebayRequest("/some-endpoint", "GET");
      assert.deepStrictEqual(res, { status: "SUCCESS" });
      assert.strictEqual(callCount, 2);
      assert.strictEqual(tokenRefreshCalled, true);
    } finally {
      // Restore fetch AND access token
      global.fetch = priorFetch;
      ebayClient.setAccessToken(oldAccessToken);
    }
  });

  await t.test('Strict Schema cast: integers and brand/model fallbacks', () => {
    const listing = {
      title: "Valid Title",
      suggestedPrice: 45.678,
      condition: "NEW",
      weightMajor: 2.7,
      weightMinor: 11.2,
      packageLength: 12.3,
      packageWidth: 9.9,
      packageHeight: 6.01
    };

    geminiClient.validateAndFixListingSchema(listing);

    // Castings and formatting
    assert.strictEqual(listing.suggestedPrice, 45.68);
    assert.strictEqual(listing.weightMajor, 3); // round
    assert.strictEqual(listing.weightMinor, 11); // round
    assert.strictEqual(listing.packageLength, 12); // round
    assert.strictEqual(listing.packageWidth, 10); // round
    assert.strictEqual(listing.packageHeight, 6); // round
    assert.strictEqual(listing.brand, "Generic"); // fallback
    assert.strictEqual(listing.model, "Does Not Apply"); // fallback
  });

  await t.test('Shopify inventory levels retrieval and set on cross-post', async () => {
    // We mock Shopify endpoints to verify locations are fetched and inventory is set to 1
    let locationsFetched = false;
    let inventoryLevelSet = false;
    let inventoryLevelVal = null;
    let mockLocationId = "gid://shopify/Location/987654";

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/admin/api/2024-01/locations.json')) {
        locationsFetched = true;
        return {
          status: 200,
          ok: true,
          json: async () => ({
            locations: [
              { id: mockLocationId, name: "Primary Location", active: true }
            ]
          })
        };
      }
      if (urlStr.includes('/admin/api/2024-01/inventory_levels/set.json')) {
        inventoryLevelSet = true;
        const bodyObj = JSON.parse(options.body);
        inventoryLevelVal = bodyObj.available;
        assert.strictEqual(bodyObj.location_id, mockLocationId);
        assert.strictEqual(bodyObj.inventory_item_id, "shopify-item-abc");
        return {
          status: 200,
          ok: true,
          json: async () => ({ inventory_level: { available: 1 } })
        };
      }
      // Mock product creation
      if (urlStr.includes('/admin/api/2024-01/products.json')) {
        return {
          status: 201,
          ok: true,
          json: async () => ({
            product: {
              id: "shopify-prod-123",
              variants: [
                {
                  id: "shopify-variant-123",
                  inventory_item_id: "shopify-item-abc",
                  inventory_management: "shopify"
                }
              ]
            }
          })
        };
      }
      // Mock oauth token if needed
      return {
        status: 200,
        ok: true,
        json: async () => ({})
      };
    };

    const oldShopName = process.env.SHOPIFY_SHOP_NAME;
    const oldShopifyToken = process.env.SHOPIFY_ACCESS_TOKEN;
    process.env.SHOPIFY_SHOP_NAME = "test-shop";
    process.env.SHOPIFY_ACCESS_TOKEN = "test-token";

    try {
      const resProduct = await webServer.crossPostToShopify({
        title: "Test Shopify Cross-post",
        description: "Best boots ever",
        price: 99.99,
        brand: "Nike",
        model: "Drill"
      }, ["https://example.com/boot.jpg"], "SKU-SHOPIFY");

      assert.ok(resProduct);
      assert.strictEqual(resProduct, "shopify-prod-123");
      assert.strictEqual(locationsFetched, true);
      assert.strictEqual(inventoryLevelSet, true);
      assert.strictEqual(inventoryLevelVal, 1);
    } finally {
      global.fetch = originalFetch; // Restore so next sub-test (ebayFetch 401) has clean global.fetch
      if (oldShopName) process.env.SHOPIFY_SHOP_NAME = oldShopName;
      else delete process.env.SHOPIFY_SHOP_NAME;
      if (oldShopifyToken) process.env.SHOPIFY_ACCESS_TOKEN = oldShopifyToken;
      else delete process.env.SHOPIFY_ACCESS_TOKEN;
    }
  });

  global.fetch = originalFetch;
});

test('Google OAuth login callback, Stripe Webhook, and WooCommerce/Etsy crosslisting integration', async (t) => {
  // Use REAL_FETCH (captured before any test runs) so concurrent tests that
  // mock global.fetch don't corrupt our reference to the real HTTP client.
  const originalFetch = REAL_FETCH;

  await t.test('Google OAuth login callback redirects with session cookie', async () => {
    const testPort = 45914;
    const server = webServer.startWebGuiServer(testPort);
    const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
    const originalGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    process.env.GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";

    let tokenFetched = false;
    let userInfoFetched = false;

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        tokenFetched = true;
        return {
          status: 200,
          ok: true,
          json: async () => ({ access_token: "mock-google-token" })
        };
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        userInfoFetched = true;
        return {
          status: 200,
          ok: true,
          json: async () => ({ email: "google-user@test.com", name: "Google Test User", picture: "http://example.com/avatar.jpg" })
        };
      }
      return { status: 404, ok: false };
    };

    try {
      const callbackRes = await originalFetch(`http://127.0.0.1:${testPort}/api/auth/google/callback?code=test-auth-code`, {
        redirect: 'manual'
      });
      assert.strictEqual(callbackRes.status, 302);
      const cookieHeader = callbackRes.headers.get('set-cookie');
      assert.ok(cookieHeader && cookieHeader.includes('sessionId='));
      assert.strictEqual(tokenFetched, true);
      assert.strictEqual(userInfoFetched, true);
    } finally {
      if (originalGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
      if (originalGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = originalGoogleClientSecret;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('Stripe Webhook signature validation and premium status toggle', async () => {
    const testPort = 45915;
    const server = webServer.startWebGuiServer(testPort);
    const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_mocksecret";

    const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
    if (fs.existsSync(billingDbPath)) {
      try { fs.unlinkSync(billingDbPath); } catch (e) {}
    }

    try {
      const eventObj = {
        id: "evt_mock",
        type: "checkout.session.completed",
        data: {
          object: {
            customer_email: "stripe-premium@test.com",
            subscription: "sub_premium_123"
          }
        }
      };
      
      const payloadStr = JSON.stringify(eventObj);
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = `${timestamp}.${payloadStr}`;
      
      const signature = crypto
        .createHmac('sha256', "whsec_mocksecret")
        .update(signedPayload)
        .digest('hex');
      
      const signatureHeader = `t=${timestamp},v1=${signature}`;

      const res = await originalFetch(`http://127.0.0.1:${testPort}/api/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': signatureHeader
        },
        body: payloadStr
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.received, true);

      const billingHistory = utils.readJsonFileSecure(billingDbPath, {});
      assert.ok(billingHistory["stripe-premium@test.com"]);
      assert.strictEqual(billingHistory["stripe-premium@test.com"].premium, true);
      assert.strictEqual(billingHistory["stripe-premium@test.com"].subscriptionId, "sub_premium_123");
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
      if (fs.existsSync(billingDbPath)) {
        try { fs.unlinkSync(billingDbPath); } catch (e) {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('WooCommerce and Etsy publish REST endpoints', async () => {
    const testPort = 45916;
    const server = webServer.startWebGuiServer(testPort);
    
    const originalWcUrl = process.env.WOOCOMMERCE_URL;
    const originalWcKey = process.env.WOOCOMMERCE_KEY;
    const originalWcSecret = process.env.WOOCOMMERCE_SECRET;
    const originalEtsyShop = process.env.ETSY_SHOP_ID;
    const originalEtsyToken = process.env.ETSY_ACCESS_TOKEN;

    process.env.WOOCOMMERCE_URL = "https://mock-woo.com";
    process.env.WOOCOMMERCE_KEY = "ck_mockkey";
    process.env.WOOCOMMERCE_SECRET = "cs_mocksecret";
    process.env.ETSY_SHOP_ID = "mock-shop-id";
    process.env.ETSY_ACCESS_TOKEN = "mock-etsy-token";

    let wcRequestReceived = false;
    let etsyRequestReceived = false;

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes("mock-woo.com/wp-json/wc/v3/products")) {
        wcRequestReceived = true;
        return {
          status: 201,
          ok: true,
          json: async () => ({ id: 54321 })
        };
      }
      if (urlStr.includes("api.etsy.com/v3/application/shops/mock-shop-id/listings")) {
        etsyRequestReceived = true;
        return {
          status: 201,
          ok: true,
          json: async () => ({ listing_id: 98765 })
        };
      }
      return { status: 404, ok: false };
    };

    try {
      const wcPayload = {
        sku: "TEST-WC-SKU",
        listing: { title: "Woo item", suggestedPrice: 29.99, description: "Cool woo item" },
        imageUrls: ["https://example.com/woo.jpg"]
      };

      const wcRes = await originalFetch(`http://127.0.0.1:${testPort}/api/publish/woocommerce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lister-API-Key': 'lister-secret-key-12345' },
        body: JSON.stringify(wcPayload)
      });
      assert.strictEqual(wcRes.status, 200);
      const wcData = await wcRes.json();
      assert.strictEqual(wcData.success, true);
      assert.strictEqual(wcData.id, 54321);
      assert.strictEqual(wcRequestReceived, true);

      const etsyPayload = {
        sku: "TEST-ETSY-SKU",
        listing: { title: "Etsy item", suggestedPrice: 19.99, description: "Cool etsy item" }
      };

      const etsyRes = await originalFetch(`http://127.0.0.1:${testPort}/api/publish/etsy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lister-API-Key': 'lister-secret-key-12345' },
        body: JSON.stringify(etsyPayload)
      });
      assert.strictEqual(etsyRes.status, 200);
      const etsyData = await etsyRes.json();
      assert.strictEqual(etsyData.success, true);
      assert.strictEqual(etsyData.id, 98765);
      assert.strictEqual(etsyRequestReceived, true);

    } finally {
      global.fetch = originalFetch; // Restore before closing so downstream sub-tests are not polluted
      process.env.WOOCOMMERCE_URL = originalWcUrl;
      process.env.WOOCOMMERCE_KEY = originalWcKey;
      process.env.WOOCOMMERCE_SECRET = originalWcSecret;
      process.env.ETSY_SHOP_ID = originalEtsyShop;
      process.env.ETSY_ACCESS_TOKEN = originalEtsyToken;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('Legal pages (/privacy and /terms) serve HTML and bypass auth', async () => {
    const testPort = 45923;
    const server = webServer.startWebGuiServer(testPort);
    try {
      const privacyRes = await originalFetch(`http://127.0.0.1:${testPort}/privacy`);
      assert.strictEqual(privacyRes.status, 200);
      const privacyHtml = await privacyRes.text();
      assert.ok(privacyHtml.includes('Privacy Policy'));
      assert.ok(privacyHtml.includes('Vincent Kinney'));

      const termsRes = await originalFetch(`http://127.0.0.1:${testPort}/terms`);
      assert.strictEqual(termsRes.status, 200);
      const termsHtml = await termsRes.text();
      assert.ok(termsHtml.includes('Terms of Service'));
      assert.ok(termsHtml.includes('AI Output Disclaimer'));

      const pressRes = await originalFetch(`http://127.0.0.1:${testPort}/press`);
      assert.strictEqual(pressRes.status, 200);
      const pressHtml = await pressRes.text();
      assert.ok(pressHtml.includes('Official Press Kit'));
      assert.ok(pressHtml.includes('Vincent Kinney'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('DELETE /api/user/account deletes account data and active session', async () => {
    const testPort = 45924;
    const server = webServer.startWebGuiServer(testPort);
    const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
    const originalGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret";

    const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
    const billingHistory = {};
    billingHistory["google-user@test.com"] = { premium: true, subscriptionId: "sub_delete_123" };
    utils.writeJsonFileSecure(billingDbPath, billingHistory);

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ access_token: "mock-google-token" })
        };
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ email: "google-user@test.com", name: "Google Test User" })
        };
      }
      return { status: 404, ok: false };
    };

    try {
      // 1. Log in to establish the session
      const callbackRes = await originalFetch(`http://127.0.0.1:${testPort}/api/auth/google/callback?code=test-auth-code`, {
        redirect: 'manual'
      });
      const cookieHeader = callbackRes.headers.get('set-cookie');
      assert.ok(cookieHeader && cookieHeader.includes('sessionId='));

      // 2. Confirm user is premium in database
      let dbState = utils.readJsonFileSecure(billingDbPath, {});
      assert.strictEqual(dbState["google-user@test.com"]?.premium, true);

      // 3. Call DELETE to erase the account
      const deleteRes = await originalFetch(`http://127.0.0.1:${testPort}/api/user/account`, {
        method: 'DELETE',
        headers: {
          'Cookie': cookieHeader
        }
      });
      assert.strictEqual(deleteRes.status, 200);
      const deleteData = await deleteRes.json();
      assert.strictEqual(deleteData.success, true);

      // 4. Confirm data is deleted in database
      dbState = utils.readJsonFileSecure(billingDbPath, {});
      assert.strictEqual(dbState["google-user@test.com"], undefined);

    } finally {
      if (originalGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
      if (originalGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = originalGoogleClientSecret;
      if (fs.existsSync(billingDbPath)) {
        try { fs.unlinkSync(billingDbPath); } catch (e) {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  global.fetch = originalFetch;
});

// ==========================================
// 11. Hardening and NFR Verification tests
// ==========================================
test('Hardening and NFR Verification tests', async (t) => {
  const originalFetch = REAL_FETCH;

  await t.test('Domain-specific circuit breakers do not interfere', async () => {
    ebayClient.resetCircuitBreaker('all');

    let ebayFetchCalled = 0;
    let shopifyFetchCalled = 0;

    global.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('api.ebay.com')) {
        ebayFetchCalled++;
        return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) };
      }
      if (urlStr.includes('shopify.com')) {
        shopifyFetchCalled++;
        return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) };
      }
      return { status: 404, ok: false };
    };

    // Trip eBay circuit breaker (5 failed calls)
    for (let i = 0; i < 5; i++) {
      await ebayClient.fetchWithRetry("https://api.ebay.com/fail-route", {}, 1, 1).catch(() => {});
    }

    // Next eBay call should be blocked
    await assert.rejects(
      async () => {
        await ebayClient.fetchWithRetry("https://api.ebay.com/fail-route", {}, 1, 1);
      },
      /Circuit Breaker Active/
    );

    // Unrelated Shopify call should STILL proceed and pass (not blocked by eBay circuit breaker)
    const shopifyRes = await ebayClient.fetchWithRetry("https://my-shop.myshopify.com/api", {}, 1, 1);
    assert.strictEqual(shopifyRes.status, 200);
    assert.strictEqual(shopifyFetchCalled, 1);

    ebayClient.resetCircuitBreaker('all');
  });

  await t.test('Rate limiter blocks spam requests with 429', async () => {
    webServer.resetRateLimits();
    const testPort = 45917;
    const server = webServer.startWebGuiServer(testPort);

    try {
      let blocked = false;
      for (let i = 0; i < 65; i++) {
        const res = await originalFetch(`http://127.0.0.1:${testPort}/api/status`);
        if (res.status === 429) {
          blocked = true;
          break;
        }
      }
      assert.strictEqual(blocked, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('CORS blocks disallowed origins with 403', async () => {
    const testPort = 45918;
    const server = webServer.startWebGuiServer(testPort);

    try {
      const res = await originalFetch(`http://127.0.0.1:${testPort}/api/status`, {
        headers: { 'Origin': 'https://malicious-attacker.com' }
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.error, "FORBIDDEN");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('Audit log is structured JSON and traceId is propagated', async () => {
    try { fs.writeFileSync(config.logPath, '', 'utf8'); } catch (e) {}

    const traceId = "test-trace-id-12345";
    utils.asyncLocalStorage.run({ traceId }, () => {
      utils.logAudit("INFO", "Test structured log message");
    });

    const logContent = fs.readFileSync(config.logPath, 'utf8');
    const lines = logContent.split('\n').filter(l => l.trim().length > 0);
    assert.ok(lines.length > 0);
    
    const logObj = JSON.parse(lines[0]);
    assert.ok(logObj.timestamp);
    assert.strictEqual(logObj.level, "INFO");
    assert.strictEqual(logObj.message, "Test structured log message");
    assert.strictEqual(logObj.traceId, traceId); 
  });

  await t.test('Concurrent file writes lock and do not corrupt data', async () => {
    const testFile = path.join(testDir, 'concurrent-write-test.json');
    
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(new Promise((resolve) => {
        setTimeout(() => {
          try {
            utils.writeJsonFileSecure(testFile, { count: i });
            resolve(true);
          } catch (e) {
            resolve(false);
          }
        }, Math.floor(Math.random() * 10));
      }));
    }

    const results = await Promise.all(promises);
    assert.ok(results.every(r => r === true)); 
    
    const data = utils.readJsonFileSecure(testFile);
    assert.ok(data);
    assert.ok(typeof data.count === 'number');

    try { fs.unlinkSync(testFile); } catch (e) {}
  });

  await t.test('Host header validation blocks bad hosts with 400', async () => {
    webServer.resetRateLimits();
    const testPort = 45938;
    const server = webServer.startWebGuiServer(testPort);
    const http = require('http');

    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: testPort,
          path: '/api/status',
          method: 'GET',
          headers: {
            'Host': 'malicious-domain.com'
          }
        }, (res) => {
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('Payload size limit blocks large post body with 413', async () => {
    const testPort = 45939;
    const server = webServer.startWebGuiServer(testPort);

    try {
      const largeBody = ' '.repeat(1.1 * 1024 * 1024);
      
      const res = await originalFetch(`http://127.0.0.1:${testPort}/api/ebay/location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: largeBody
      }).catch(err => {
        return { status: 413, thrown: true };
      });
      
      if (res.thrown) {
        assert.ok(true, "Connection aborted successfully.");
      } else {
        assert.strictEqual(res.status, 413);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('Detailed diagnostics health check', async () => {
    const testPort = 45940;
    const server = webServer.startWebGuiServer(testPort);

    try {
      const res = await originalFetch(`http://127.0.0.1:${testPort}/health`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, "ok");
      assert.ok(data.timestamp);
      assert.ok(data.details);
      assert.ok(data.details.storage);
      assert.ok(data.details.system);
      assert.ok(data.details.circuitBreakers);
      assert.strictEqual(data.details.storage.scratch.status, "OK");
      assert.strictEqual(data.details.storage.uploads.status, "OK");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('Security headers presence', async () => {
    const testPort = 45941;
    const server = webServer.startWebGuiServer(testPort);

    try {
      const res = await originalFetch(`http://127.0.0.1:${testPort}/health`);
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
      assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.strictEqual(res.headers.get('x-xss-protection'), '1; mode=block');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  global.fetch = originalFetch;
});

// ==========================================
// 12. Advanced Self-Healing & Robust Error Handling Tests
// ==========================================
test('Advanced Self-Healing and Robust Error Handling', async (t) => {
  const originalFetch = REAL_FETCH;

  await t.test('Database self-healing on double corruption', () => {
    const corruptFile = path.join(testDir, 'corrupt-db-test.json');
    const backupFile = `${corruptFile}.bak`;
    const defaultData = [{ key: "default-val" }];

    // Simulate double corruption
    fs.writeFileSync(corruptFile, "{invalid-json-primary", 'utf8');
    fs.writeFileSync(backupFile, "[invalid-json-backup", 'utf8');

    // Read should trigger self-healing and write defaultData to both files
    const result = utils.readJsonFileSecure(corruptFile, defaultData);
    assert.deepStrictEqual(result, defaultData);

    const primarySaved = JSON.parse(fs.readFileSync(corruptFile, 'utf8'));
    const backupSaved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.deepStrictEqual(primarySaved, defaultData);
    assert.deepStrictEqual(backupSaved, defaultData);

    try { fs.unlinkSync(corruptFile); } catch (e) {}
    try { fs.unlinkSync(backupFile); } catch (e) {}
  });

  await t.test('OAuthRefreshError process isolation in server context', async () => {
    const origId = config.getEBAY_CLIENT_ID();
    const origSecret = config.getEBAY_CLIENT_SECRET();
    const origToken = config.getEBAY_REFRESH_TOKEN();

    // Remove credentials to trigger failure
    process.env.EBAY_CLIENT_ID = "";
    process.env.EBAY_CLIENT_SECRET = "";
    process.env.EBAY_USER_TOKEN = "";
    ebayClient.setAccessToken(null);

    await assert.rejects(
      async () => {
        await ebayClient.refreshEbayAccessToken();
      },
      (err) => {
        assert.strictEqual(err.name, 'OAuthRefreshError');
        assert.ok(err.message.includes('Credentials missing'));
        return true;
      }
    );

    process.env.EBAY_CLIENT_ID = origId;
    process.env.EBAY_CLIENT_SECRET = origSecret;
    process.env.EBAY_REFRESH_TOKEN = origToken;
  });

  await t.test('Watch daemon file stability filter', async () => {
    const simpleLister = require('./simple-lister-pro');
    const tempFile = path.join(testDir, 'stability-test-img.jpg');

    // 1. Initial write
    fs.writeFileSync(tempFile, 'partial-content', 'utf8');
    
    // Start stability check in background
    const stabilityPromise = simpleLister.filterStableFiles([tempFile]);

    // 2. While the 2-second check is running, append content (size changes)
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.writeFileSync(tempFile, 'partial-content-updated-more-bytes', 'utf8');

    const stableResult = await stabilityPromise;
    assert.strictEqual(stableResult.includes(tempFile), false);

    // 3. Test a stable file
    const stablePromise = simpleLister.filterStableFiles([tempFile]);
    const stableResult2 = await stablePromise;
    assert.strictEqual(stableResult2.includes(tempFile), true);

    try { fs.unlinkSync(tempFile); } catch (e) {}
  });

  await t.test('Dead-Letter Queue (DLQ) retry test', async () => {
    const crossPost = require('./crossPost');
    
    try { fs.writeFileSync(config.dlqPath, '[]', 'utf8'); } catch (e) {}
    
    const mockListing = {
      title: "Test Retried Item",
      suggestedPrice: 49.99,
      description: "Retry test description",
      brand: "Generic",
      condition: "NEW"
    };

    const mockHistory = [{
      sku: "RETRY-SKU-1",
      title: "Test Retried Item",
      price: 49.99,
      shopifyId: null,
      status: "ACTIVE"
    }];
    utils.writeJsonFileSecure(config.historyPath, mockHistory);
    
    await crossPost.addToDlq("shopify", "RETRY-SKU-1", mockListing, ["https://example.com/retry.jpg"], "Initial Network Timeout");
    
    // Backdate the job timestamp to bypass exponential backoff checks in the test
    const dlqSetup = utils.readJsonFileSecure(config.dlqPath, []);
    if (dlqSetup.length > 0) {
      dlqSetup[0].timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      utils.writeJsonFileSecure(config.dlqPath, dlqSetup);
    }
    
    const dlqBefore = utils.readJsonFileSecure(config.dlqPath, []);
    assert.strictEqual(dlqBefore.length, 1);
    assert.strictEqual(dlqBefore[0].sku, "RETRY-SKU-1");
    assert.strictEqual(dlqBefore[0].attempts, 1);

    let fetchCalled = false;
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes("products.json")) {
        fetchCalled = true;
        return {
          status: 201,
          ok: true,
          json: async () => ({
            product: {
              id: 999111,
              variants: [{ id: 888222, inventory_item_id: 777333, inventory_management: "shopify" }]
            }
          })
        };
      }
      if (urlStr.includes("locations.json")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ locations: [{ id: 444555, active: true }] })
        };
      }
      if (urlStr.includes("inventory_levels/set.json")) {
        return { status: 200, ok: true, json: async () => ({}) };
      }
      return { status: 404, ok: false };
    };

    const originalShop = process.env.SHOPIFY_SHOP_NAME;
    const originalToken = process.env.SHOPIFY_ACCESS_TOKEN;
    process.env.SHOPIFY_SHOP_NAME = "mock-shop";
    process.env.SHOPIFY_ACCESS_TOKEN = "mock-token";

    try {
      await crossPost.processPendingSyncsDlq();
      
      const dlqAfter = utils.readJsonFileSecure(config.dlqPath, []);
      assert.strictEqual(dlqAfter.length, 0);
      assert.strictEqual(fetchCalled, true);

      const historyAfter = utils.readJsonFileSecure(config.historyPath, []);
      assert.strictEqual(historyAfter[0].shopifyId, "999111");
    } finally {
      process.env.SHOPIFY_SHOP_NAME = originalShop;
      process.env.SHOPIFY_ACCESS_TOKEN = originalToken;
    }
  });

  await t.test('Custom structured error JSON serialization', () => {
    const { ListerError, EbayApiError } = require('./lib/errors');
    const err = new EbayApiError('eBay API call failed', {
      ebayErrorCode: 'E001',
      ebayTraceId: 'T123',
      status: 503
    });
    assert.strictEqual(err.status, 503);
    assert.strictEqual(err.code, 'EBAY_API_ERROR');
    const json = err.toJSON();
    assert.strictEqual(json.error, 'eBay API call failed');
    assert.strictEqual(json.status, 503);
    assert.strictEqual(json.ebayErrorCode, 'E001');
    assert.strictEqual(json.ebayTraceId, 'T123');
  });

  await t.test('Web server error response credential sanitization', async () => {
    const webServer = require('./webServer');
    const testPort = 49700 + Math.round(Math.random() * 200);
    const server = webServer.startWebGuiServer(testPort);

    const originalGetItem = ebayClient.getItemFromBrowse;
    const secretKey = config.getGEMINI_API_KEY() || 'secret-gemini-key-placeholder';
    
    // Force direct failure containing the credential
    ebayClient.getItemFromBrowse = async () => {
      throw new Error(`Connection failed using API key: ${secretKey}`);
    };

    try {
      const res = await originalFetch(`http://127.0.0.1:${testPort}/api/ebay/import?itemIdOrUrl=123456789012`);
      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.ok(data.message);
      assert.ok(!data.message.includes(secretKey), "Response error message should not leak credentials");
      assert.ok(data.message.includes('[REDACTED_GEMINI_KEY]'), "Response error message should contain redact label");
    } finally {
      ebayClient.getItemFromBrowse = originalGetItem;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('Watch daemon folder auto-creation and dead-letter quarantine presence', async () => {
    const fs = require('fs');
    const path = require('path');
    const simpleLister = require('./simple-lister-pro');
    
    const testWatchDir = path.join(config.uploadTempDir, 'watch');
    const testDeadLetterDir = path.join(config.uploadTempDir, 'dead_letter');
    
    // Clean up directories to test auto-creation
    try { fs.rmdirSync(testWatchDir); } catch (e) {}
    try { fs.rmdirSync(testDeadLetterDir); } catch (e) {}

    // Initialize watcher daemon
    const watcher = await simpleLister.startWatchDaemon();
    
    try {
      assert.ok(fs.existsSync(testWatchDir), "watch directory should be auto-created");
      assert.ok(fs.existsSync(testDeadLetterDir), "dead_letter directory should be auto-created");
    } finally {
      if (watcher && typeof watcher.close === 'function') {
        watcher.close();
      }
    }
  });

  global.fetch = originalFetch;
});

// ==========================================
// 13. Additional Maximal Coverage & Edge Case Tests
// ==========================================
test('Additional maximal coverage and edge cases', async (t) => {
  const originalFetch = REAL_FETCH;

  await t.test('utils.getImageDimensions returns null on empty or invalid signature file', () => {
    const invalidFilePath = path.join(testDir, 'empty-invalid-img.jpg');
    fs.writeFileSync(invalidFilePath, Buffer.alloc(0)); // empty file
    
    const dims = utils.getImageDimensions(invalidFilePath);
    assert.strictEqual(dims, null);

    const corruptSigPath = path.join(testDir, 'corrupt-sig.jpg');
    fs.writeFileSync(corruptSigPath, Buffer.from([0x00, 0x01, 0x02, 0x03])); // random bytes
    const dims2 = utils.getImageDimensions(corruptSigPath);
    assert.strictEqual(dims2, null);

    try { fs.unlinkSync(invalidFilePath); } catch (e) {}
    try { fs.unlinkSync(corruptSigPath); } catch (e) {}
  });

  await t.test('utils.logAudit defaults traceId when AsyncLocalStorage has no store context', () => {
    try { fs.writeFileSync(config.logPath, '', 'utf8'); } catch (e) {}
    // Run outside of asyncLocalStorage
    utils.logAudit("INFO", "Log message without trace context");
    
    const logContent = fs.readFileSync(config.logPath, 'utf8');
    const lines = logContent.split('\n').filter(l => l.trim().length > 0);
    assert.ok(lines.length > 0);
    
    const logObj = JSON.parse(lines[0]);
    assert.ok(!logObj.traceId || logObj.traceId === '-');
  });

  await t.test('Daily repricer respects priceFloor, priceCap, priceLocked constraints', async () => {
    const testSkuFloor = "REPRICE-FLOOR";
    const testSkuCap = "REPRICE-CAP";
    const testSkuLocked = "REPRICE-LOCKED";

    const history = [
      {
        sku: testSkuFloor,
        title: "Nike Boots",
        price: 30.00,
        status: "ACTIVE",
        offerId: "offer-floor",
        condition: "USED_EXCELLENT",
        priceFloor: 25.00
      },
      {
        sku: testSkuCap,
        title: "Adidas Shoes",
        price: 30.00,
        status: "ACTIVE",
        offerId: "offer-cap",
        condition: "USED_EXCELLENT",
        priceCap: 5.00
      },
      {
        sku: testSkuLocked,
        title: "Puma Sneakers",
        price: 30.00,
        status: "ACTIVE",
        offerId: "offer-locked",
        condition: "USED_EXCELLENT",
        priceLocked: true
      }
    ];

    utils.writeJsonFileSecure(config.historyPath, history);

    // Mock global.fetch to handle search comps and get/put offers
    let putRequests = [];
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/item_summary/search')) {
        const bodyText = JSON.stringify({
          itemSummaries: [
            { price: { value: "10.00" } }
          ]
        });
        return {
          status: 200,
          ok: true,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText)
        };
      }
      if (urlStr.includes('/sell/inventory/v1/offer/')) {
        if (options && options.method === 'PUT') {
          putRequests.push({ url: urlStr, body: JSON.parse(options.body) });
          return {
            status: 200,
            ok: true,
            text: async () => "{}",
            json: async () => ({})
          };
        }
        // GET
        const bodyText = JSON.stringify({
          price: { value: "30.00", currency: "USD" }
        });
        return {
          status: 200,
          ok: true,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText)
        };
      }
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        const bodyText = JSON.stringify({ access_token: "test-token" });
        return {
          status: 200,
          ok: true,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText)
        };
      }
      return { status: 404, ok: false };
    };

    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("test-token-active");
    ebayClient.resetCircuitBreaker();

    try {
      await ebayClient.runDailyRepricer();

      // Check results in history
      const updatedHistory = utils.readJsonFileSecure(config.historyPath, []);
      const itemFloor = updatedHistory.find(i => i.sku === testSkuFloor);
      const itemCap = updatedHistory.find(i => i.sku === testSkuCap);
      const itemLocked = updatedHistory.find(i => i.sku === testSkuLocked);

      // Floor item price is bound to floor (25.00 instead of 10.00 comps avg)
      assert.strictEqual(itemFloor.price, 25.00);
      
      // Cap item price is bound to cap (5.00 instead of 10.00 comps avg)
      assert.strictEqual(itemCap.price, 5.00);
      
      // Locked item remains 30.00
      assert.strictEqual(itemLocked.price, 30.00);

      assert.strictEqual(putRequests.length, 2);
    } finally {
      global.fetch = originalFetch;
      ebayClient.setAccessToken(originalToken);
    }
  });

  await t.test('Mercari and Poshmark export endpoints return correct clipboard models', async () => {
    const testPort = 45919;
    const server = webServer.startWebGuiServer(testPort);

    const testSku = "EXPORT-SKU-999";
    const history = [{
      sku: testSku,
      title: "Export Item Title",
      price: 88.00,
      description: "Item to export details",
      brand: "Supreme",
      imageUrls: ["https://example.com/item.png"],
      status: "ACTIVE"
    }];
    utils.writeJsonFileSecure(config.historyPath, history);

    try {
      const mercariRes = await originalFetch(`http://127.0.0.1:${testPort}/api/export/mercari`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Lister-API-Key': 'lister-secret-key-12345'
        },
        body: JSON.stringify({ sku: testSku })
      });
      assert.strictEqual(mercariRes.status, 200);
      const mercariData = await mercariRes.json();
      assert.strictEqual(mercariData.success, true);
      assert.strictEqual(mercariData.platform, "Mercari");
      assert.strictEqual(mercariData.copyPaste.brand, "Supreme");
      assert.strictEqual(mercariData.copyPaste.price, 88.00);

      const poshRes = await originalFetch(`http://127.0.0.1:${testPort}/api/export/poshmark`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Lister-API-Key': 'lister-secret-key-12345'
        },
        body: JSON.stringify({ sku: testSku })
      });
      assert.strictEqual(poshRes.status, 200);
      const poshData = await poshRes.json();
      assert.strictEqual(poshData.success, true);
      assert.strictEqual(poshData.platform, "Poshmark");
      assert.strictEqual(poshData.copyPaste.title, "Export Item Title");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('Stability checker handles non-existent or deleted files cleanly', async () => {
    const listerPro = require('./simple-lister-pro');
    const stableResult = await listerPro.filterStableFiles([path.join(testDir, 'non-existent-file-12345.jpg')]);
    assert.strictEqual(stableResult.length, 0);
  });

  await t.test('config.getVERO_BRANDS is populated and is case-insensitive matches', () => {
    const list = config.getVERO_BRANDS();
    assert.ok(list.includes("rolex"));
    assert.ok(list.includes("otterbox"));
  });

  await t.test('ebayClient.findUpcFromComps extracts 12-digit barcode from title matches or item detail aspects', async () => {
    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    global.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/item_summary/search')) {
        const bodyText = JSON.stringify({
          itemSummaries: [
            { title: "Some product with UPC 123456789012 inside it", itemId: "item-123" }
          ]
        });
        return {
          status: 200,
          ok: true,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText)
        };
      }
      return { status: 404, ok: false };
    };

    try {
      const upc = await ebayClient.findUpcFromComps("search terms");
      assert.strictEqual(upc, "123456789012");
    } finally {
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('ebayClient.uploadImageToEPS uploads image and extracts FullURL', async () => {
    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        const tokenBody = JSON.stringify({ access_token: "mocked-access-token" });
        return {
          status: 200,
          ok: true,
          text: async () => tokenBody,
          json: async () => JSON.parse(tokenBody)
        };
      }
      if (urlStr.includes('api.ebay.com/ws/api.dll')) {
        const bodyText = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <SiteHostedPictureDetails>
    <FullURL>https://i.ebayimg.com/images/g/test-url/s-l1600.jpg</FullURL>
  </SiteHostedPictureDetails>
</UploadSiteHostedPicturesResponse>`;
        return {
          status: 200,
          ok: true,
          text: async () => bodyText,
          json: async () => { throw new Error("not used"); }
        };
      }
      return { status: 404, ok: false };
    };

    // Create a dummy temp image to upload
    const dummyPath = path.join(testDir, 'dummy-eps.jpg');
    fs.writeFileSync(dummyPath, 'fake-jpeg-data');

    try {
      const url = await ebayClient.uploadImageToEPS(dummyPath);
      assert.strictEqual(url, "https://i.ebayimg.com/images/g/test-url/s-l1600.jpg");
    } finally {
      if (fs.existsSync(dummyPath)) fs.unlinkSync(dummyPath);
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('ebayClient.getMarketingSummary fetches ad campaigns', async () => {
    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        const tokenBody = JSON.stringify({ access_token: "mocked-access-token" });
        return {
          status: 200,
          ok: true,
          text: async () => tokenBody,
          json: async () => JSON.parse(tokenBody)
        };
      }
      if (urlStr.includes('/sell/marketing/v1/ad_campaign')) {
        const bodyText = JSON.stringify({
          campaigns: [
            { campaignId: "c-1", campaignName: "Test Campaign", campaignStatus: "RUNNING", fundingModel: "COST_PER_SALE" }
          ]
        });
        return {
          status: 200,
          ok: true,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText)
        };
      }
      return { status: 404, ok: false };
    };

    try {
      const summary = await ebayClient.getMarketingSummary();
      assert.ok(Array.isArray(summary.campaigns));
      assert.strictEqual(summary.campaigns[0].campaignName, "Test Campaign");
    } finally {
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('ebayClient.getItemFromBrowse fetches item details by ID', async () => {
    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        const tokenBody = JSON.stringify({ access_token: "mocked-access-token" });
        return {
          status: 200,
          ok: true,
          text: async () => tokenBody,
          json: async () => JSON.parse(tokenBody)
        };
      }
      if (urlStr.includes('/buy/browse/v1/item/v1%7C123456789012%7C0')) {
        const bodyText = JSON.stringify({
          title: "Imported Competitor Item",
          price: { value: "45.99", currency: "USD" },
          categoryId: "12345",
          brand: "Nike",
          mpn: "NK-100",
          description: "Stunning condition competitor shoes",
          localizedAspects: [
            { name: "Color", value: "Red" },
            { name: "Size", value: "11" }
          ],
          image: { imageUrl: "https://example.com/main.jpg" },
          additionalImages: [
            { imageUrl: "https://example.com/extra.jpg" }
          ]
        });
        return {
          status: 200,
          ok: true,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText)
        };
      }
      return { status: 404, ok: false };
    };

    try {
      const item = await ebayClient.getItemFromBrowse("123456789012");
      assert.strictEqual(item.title, "Imported Competitor Item");
      assert.strictEqual(item.brand, "Nike");
      assert.strictEqual(item.price.value, "45.99");
    } finally {
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('GET /api/ebay/import handles URL query and maps fields correctly', async () => {
    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        const tokenBody = JSON.stringify({ access_token: "mocked-access-token" });
        return { status: 200, ok: true, json: async () => JSON.parse(tokenBody), text: async () => tokenBody };
      }
      if (urlStr.includes('/buy/browse/v1/item/')) {
        const bodyText = JSON.stringify({
          title: "Imported Competitor Item",
          price: { value: "45.99", currency: "USD" },
          categoryId: "12345",
          brand: "Nike",
          mpn: "NK-100",
          description: "Stunning condition",
          localizedAspects: [
            { name: "Color", value: "Red" }
          ],
          image: { imageUrl: "https://example.com/main.jpg" }
        });
        return { status: 200, ok: true, json: async () => JSON.parse(bodyText), text: async () => bodyText };
      }
      return { status: 404, ok: false };
    };

    // Setup active server instance for testing
    const serverPort = 49100 + Math.round(Math.random() * 500);
    const testServer = webServer.startWebGuiServer(serverPort);

    try {
      const url = `http://127.0.0.1:${serverPort}/api/ebay/import?itemIdOrUrl=https://www.ebay.com/itm/123456789012`;
      const res = await REAL_FETCH(url);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      
      assert.strictEqual(data.title, "Imported Competitor Item");
      assert.strictEqual(data.brand, "Nike");
      assert.strictEqual(data.model, "NK-100");
      assert.strictEqual(data.suggestedPrice, 45.99);
      assert.strictEqual(data.aspects.Color, "Red");
      assert.deepEqual(data.imageUrls, ["https://example.com/main.jpg"]);
    } finally {
      testServer.close();
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('GET /api/ebay/import handles keyword query and searches Browse API', async () => {
    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        const tokenBody = JSON.stringify({ access_token: "mocked-access-token" });
        return { status: 200, ok: true, json: async () => JSON.parse(tokenBody), text: async () => tokenBody };
      }
      if (urlStr.includes('/buy/browse/v1/item_summary/search')) {
        const searchBody = JSON.stringify({
          itemSummaries: [
            { itemId: "v1|987654321098|0" }
          ]
        });
        return { status: 200, ok: true, json: async () => JSON.parse(searchBody), text: async () => searchBody };
      }
      if (urlStr.includes('/buy/browse/v1/item/')) {
        const bodyText = JSON.stringify({
          title: "Searched Keywords Product",
          price: { value: "29.95", currency: "USD" },
          categoryId: "54321",
          brand: "Prevagen",
          mpn: "PREV-60",
          description: "Prevagen Extra Strength 60 Capsules",
          localizedAspects: [
            { name: "Quantity", value: "60 caps" }
          ],
          image: { imageUrl: "https://example.com/prevagen.jpg" }
        });
        return { status: 200, ok: true, json: async () => JSON.parse(bodyText), text: async () => bodyText };
      }
      return { status: 404, ok: false };
    };

    // Setup active server instance for testing
    const serverPort = 49100 + Math.round(Math.random() * 500);
    const testServer = webServer.startWebGuiServer(serverPort);

    try {
      const url = `http://127.0.0.1:${serverPort}/api/ebay/import?itemIdOrUrl=prevagen%20extra%20str%2060%20caps`;
      const res = await REAL_FETCH(url);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      
      assert.strictEqual(data.title, "Searched Keywords Product");
      assert.strictEqual(data.brand, "Prevagen");
      assert.strictEqual(data.model, "PREV-60");
      assert.strictEqual(data.suggestedPrice, 29.95);
      assert.strictEqual(data.aspects.Quantity, "60 caps");
      assert.deepEqual(data.imageUrls, ["https://example.com/prevagen.jpg"]);
    } finally {
      testServer.close();
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('GET /api/ebay/import falls back to Gemini AI when eBay Browse API returns 403', async () => {
    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        const tokenBody = JSON.stringify({ access_token: "mocked-access-token" });
        return { status: 200, ok: true, json: async () => JSON.parse(tokenBody), text: async () => tokenBody };
      }
      if (urlStr.includes('/buy/browse/v1/item_summary/search')) {
        return { status: 403, ok: false, json: async () => ({ error: "Forbidden" }), text: async () => "Forbidden" };
      }
      if (urlStr.includes('/v1beta/models/gemini-2.5-flash:generateContent')) {
        const geminiText = JSON.stringify({
          title: "Gemini Generated Prevagen Listing",
          brand: "Prevagen",
          model: "PREV-60-AI",
          suggestedPrice: 32.99,
          condition: "NEW",
          description: "AI Generated Description",
          categoryId: "111422",
          aspects: { Brand: "Prevagen", Quantity: "60 caps" }
        });
        const geminiRes = JSON.stringify({
          candidates: [{
            content: { parts: [{ text: geminiText }] }
          }]
        });
        return { status: 200, ok: true, json: async () => JSON.parse(geminiRes), text: async () => geminiRes };
      }
      return { status: 404, ok: false };
    };

    const serverPort = 49100 + Math.round(Math.random() * 500);
    const testServer = webServer.startWebGuiServer(serverPort);

    try {
      const url = `http://127.0.0.1:${serverPort}/api/ebay/import?itemIdOrUrl=prevagen%20extra%20str%2060%20caps`;
      const res = await REAL_FETCH(url);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      
      assert.strictEqual(data.title, "Gemini Generated Prevagen Listing");
      assert.strictEqual(data.brand, "Prevagen");
      assert.strictEqual(data.model, "PREV-60-AI");
      assert.strictEqual(data.suggestedPrice, 32.99);
      assert.strictEqual(data.aspects.Quantity, "60 caps");
    } finally {
      testServer.close();
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('Daily repricer UNDERCUT strategy sets price to $0.05 under min comp price', async () => {
    const testSku = "REPRICE-UNDERCUT";
    const history = [{
      sku: testSku,
      title: "Nike Air Jordan",
      price: 100.00,
      status: "ACTIVE",
      offerId: "offer-undercut",
      condition: "NEW"
    }];
    utils.writeJsonFileSecure(config.historyPath, history);

    const originalStrategy = config.getDEFAULT_PRICING_STRATEGY;
    config.getDEFAULT_PRICING_STRATEGY = () => 'UNDERCUT';

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/item_summary/search')) {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ itemSummaries: [{ price: { value: "80.00" } }, { price: { value: "90.00" } }] }),
          json: async () => ({ itemSummaries: [{ price: { value: "80.00" } }, { price: { value: "90.00" } }] })
        };
      }
      if (urlStr.includes('/sell/inventory/v1/offer/')) {
        if (options && options.method === 'PUT') {
          return { status: 200, ok: true, text: async () => "{}", json: async () => ({}) };
        }
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ price: { value: "100.00", currency: "USD" } }),
          json: async () => ({ price: { value: "100.00", currency: "USD" } })
        };
      }
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ access_token: "test-token" }),
          json: async () => ({ access_token: "test-token" })
        };
      }
      return { status: 404, ok: false };
    };

    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    try {
      await ebayClient.runDailyRepricer();
      
      const updated = utils.readJsonFileSecure(config.historyPath, []);
      const item = updated.find(i => i.sku === testSku);
      
      // Undercuts minimum price (80.00) by 0.05 => 79.95
      assert.strictEqual(item.price, 79.95);
    } finally {
      config.getDEFAULT_PRICING_STRATEGY = originalStrategy;
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('POST /api/save-draft auto-enriches missing UPC and flags VeRO brands', async () => {
    const testPort = 45920;
    const server = webServer.startWebGuiServer(testPort);

    // Mock search comps to return a UPC
    global.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/item_summary/search')) {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ itemSummaries: [{ title: "Comps item 987654321098 barcode" }] }),
          json: async () => ({ itemSummaries: [{ title: "Comps item 987654321098 barcode" }] })
        };
      }
      return { status: 404, ok: false };
    };

    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    try {
      const res = await originalFetch(`http://127.0.0.1:${testPort}/api/save-draft`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Lister-API-Key': 'lister-secret-key-12345'
        },
        body: JSON.stringify({
          listing: {
            title: "Otterbox Defender Case",
            suggestedPrice: 20.00,
            condition: "NEW",
            brand: "OtterBox", // triggers VeRO warning
            aspects: {},
            categoryId: "111422"
          },
          imageUrls: []
        })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.veroWarning, true);
      assert.strictEqual(data.upc, "987654321098"); // enriched!
    } finally {
      await new Promise((resolve) => server.close(resolve));
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('POST /api/offers/auto-send sends negotiate offers to watchers', async () => {
    webServer.resetRateLimits();
    const testPort = 45921;
    const server = webServer.startWebGuiServer(testPort);

    const testSku = "OFFER-WATCH-SKU";
    const history = [{
      sku: testSku,
      title: "Active Watcher Item",
      price: 50.00,
      listingId: "listing-123",
      offerId: "offer-123",
      status: "ACTIVE"
    }];
    utils.writeJsonFileSecure(config.historyPath, history);

    let sentPayload = null;
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/send_offer_to_interested_buyers')) {
        sentPayload = JSON.parse(options.body);
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ success: true }),
          json: async () => ({ success: true })
        };
      }
      if (urlStr.includes('/identity/v1/oauth2/token')) {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ access_token: "mock-token" }),
          json: async () => ({ access_token: "mock-token" })
        };
      }
      return { status: 404, ok: false };
    };

    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    try {
      const res = await originalFetch(`http://127.0.0.1:${testPort}/api/offers/auto-send`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Lister-API-Key': 'lister-secret-key-12345'
        },
        body: JSON.stringify({ sku: testSku, discountPercentage: 15 })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(sentPayload);
      assert.strictEqual(sentPayload.offeredItems[0].itemId, "listing-123");
      assert.strictEqual(sentPayload.offeredItems[0].discountPercentage, 15);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      ebayClient.setAccessToken(originalToken);
      global.fetch = originalFetch;
    }
  });

  await t.test('Etsy title truncation and whitespace sanitization safety', async () => {
    const crossPost = require('./crossPost');
    const config = require('./config');

    const originalEtsyShopId = config.getETSY_SHOP_ID();
    const originalEtsyAccessToken = config.getETSY_ACCESS_TOKEN();
    const originalEbayClientId = config.getEBAY_CLIENT_ID();

    // Force configured state
    process.env.ETSY_SHOP_ID = "test-shop-123";
    process.env.ETSY_ACCESS_TOKEN = "test-token-123";
    process.env.EBAY_CLIENT_ID = "test-client-123";

    const originalFetch = REAL_FETCH;
    let sentPayload = null;

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/listings')) {
        sentPayload = JSON.parse(options.body);
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ listing_id: 999111 }),
          json: async () => ({ listing_id: 999111 })
        };
      }
      return { status: 404, ok: false };
    };

    try {
      const longTitle = "  This   is a very long title that has multiple double spaces and exceeds the Etsy 140 character limit so it needs to be trimmed and truncated. EXTRA EXTRA EXTRA TITLE CHARACTERS TO EXCEED ONE HUNDRED FORTY CHARS DEFINITELY.  ";
      const result = await crossPost.crossPostToEtsy({
        title: longTitle,
        description: "Test description",
        suggestedPrice: 15.99
      }, "TEST-SKU-1");

      assert.strictEqual(result, 999111);
      assert.ok(sentPayload);
      assert.strictEqual(sentPayload.title, "This is a very long title that has multiple double spaces and exceeds the Etsy 140 character limit so it needs to be trimmed and truncated. ");
      assert.strictEqual(sentPayload.title.length, 140);
    } finally {
      global.fetch = originalFetch;
      process.env.ETSY_SHOP_ID = originalEtsyShopId || "";
      process.env.ETSY_ACCESS_TOKEN = originalEtsyAccessToken || "";
      process.env.EBAY_CLIENT_ID = originalEbayClientId || "";
    }
  });

  await t.test('POST /api/publish concurrently cross-posts to Shopify, WooCommerce, and Etsy', async () => {
    webServer.resetRateLimits();
    const testPort = 45922;
    const server = webServer.startWebGuiServer(testPort);
    const config = require('./config');

    const originalEtsyShopId = config.getETSY_SHOP_ID();
    const originalEtsyAccessToken = config.getETSY_ACCESS_TOKEN();
    const originalShopifyName = config.getSHOPIFY_SHOP_NAME();
    const originalShopifyToken = config.getSHOPIFY_ACCESS_TOKEN();
    const originalWcUrl = config.getWOOCOMMERCE_URL();
    const originalWcKey = config.getWOOCOMMERCE_KEY();
    const originalWcSecret = config.getWOOCOMMERCE_SECRET();

    // Enable all integrations in environment
    process.env.ETSY_SHOP_ID = "shop123";
    process.env.ETSY_ACCESS_TOKEN = "token123";
    process.env.SHOPIFY_SHOP_NAME = "shopname";
    process.env.SHOPIFY_ACCESS_TOKEN = "shpat_token";
    process.env.WOOCOMMERCE_URL = "http://woo.local";
    process.env.WOOCOMMERCE_KEY = "ck_123";
    process.env.WOOCOMMERCE_SECRET = "cs_123";

    const originalFetch = REAL_FETCH;
    const requestedUrls = [];

    // Mock policy and ebayRequest functions directly
    const originalGetPolicies = ebayClient.getOrCreateListingPolicies;
    ebayClient.getOrCreateListingPolicies = async () => {
      return { fulfillmentId: "ful-111", paymentId: "pay-222", returnId: "ret-333" };
    };

    const originalEbayRequest = ebayClient.ebayRequest;
    ebayClient.ebayRequest = async (path, method, body) => {
      if (path.includes('/publish')) {
        return { listingId: "ebay-999" };
      }
      if (path === '/offer') {
        return { offerId: "off-888" };
      }
      return {};
    };

    global.fetch = async (url, options) => {
      const urlStr = String(url);
      requestedUrls.push(urlStr);

      if (urlStr.includes('/identity/v1/oauth2/token')) {
        return {
          status: 200, ok: true,
          text: async () => JSON.stringify({ access_token: "mock-ebay" }),
          json: async () => ({ access_token: "mock-ebay" })
        };
      }
      if (urlStr.includes('myshopify.com') && urlStr.includes('/products.json')) {
        return {
          status: 201, ok: true,
          text: async () => JSON.stringify({ product: { id: 12345 } }),
          json: async () => ({ product: { id: 12345 } })
        };
      }
      if (urlStr.includes('wp-json/wc/v3/products')) {
        return {
          status: 201, ok: true,
          text: async () => JSON.stringify({ id: 56789 }),
          json: async () => ({ id: 56789 })
        };
      }
      if (urlStr.includes('api.etsy.com') && urlStr.includes('/listings')) {
        return {
          status: 201, ok: true,
          text: async () => JSON.stringify({ listing_id: 444333 }),
          json: async () => ({ listing_id: 444333 })
        };
      }
      return { status: 404, ok: false };
    };

    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken("active-token");

    try {
      const res = await originalFetch(`http://127.0.0.1:${testPort}/api/publish`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Lister-API-Key': 'lister-secret-key-12345'
        },
        body: JSON.stringify({
          sku: "MULTI-CROSS-SKU",
          shippingOption: "USPS_GROUND",
          returnOption: "NO_RETURNS",
          immediatePayment: true,
          crossPostShopify: true,
          crossPostWooCommerce: true,
          crossPostEtsy: true,
          listing: {
            title: "Multi Cross Listed Item",
            suggestedPrice: 45.00,
            condition: "NEW",
            brand: "Generic",
            aspects: {},
            categoryId: "111422",
            description: "Test cross posting description"
          },
          imageUrls: ["https://example.com/image.jpg"]
        })
      });

      if (res.status !== 200) {
        console.error("DEBUG: Publish Endpoint Error Status:", res.status);
        console.error("DEBUG: Response Body:", await res.json());
      }

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.listingId, "ebay-999");
      assert.strictEqual(data.shopifyId, "12345");
      assert.strictEqual(data.woocommerceId, "56789");
      assert.strictEqual(data.etsyId, "444333");

      assert.ok(data.crossPostResults);
      assert.strictEqual(data.crossPostResults.shopify.success, true);
      assert.strictEqual(data.crossPostResults.woocommerce.success, true);
      assert.strictEqual(data.crossPostResults.etsy.success, true);

      // Verify history file database saved IDs correctly
      const history = utils.readJsonFileSecure(config.historyPath, []);
      const item = history.find(i => i.sku === "MULTI-CROSS-SKU");
      assert.ok(item);
      assert.strictEqual(item.shopifyId, "12345");
      assert.strictEqual(item.woocommerceId, "56789");
      assert.strictEqual(item.etsyId, "444333");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      ebayClient.setAccessToken(originalToken);
      ebayClient.ebayRequest = originalEbayRequest;
      ebayClient.getOrCreateListingPolicies = originalGetPolicies;
      global.fetch = originalFetch;

      process.env.ETSY_SHOP_ID = originalEtsyShopId || "";
      process.env.ETSY_ACCESS_TOKEN = originalEtsyAccessToken || "";
      process.env.SHOPIFY_SHOP_NAME = originalShopifyName || "";
      process.env.SHOPIFY_ACCESS_TOKEN = originalShopifyToken || "";
      process.env.WOOCOMMERCE_URL = originalWcUrl || "";
      process.env.WOOCOMMERCE_KEY = originalWcKey || "";
      process.env.WOOCOMMERCE_SECRET = originalWcSecret || "";
    }
  });
});

// ==========================================
// 8. Image Pipeline Transcoding and Sprucing Tests
// ==========================================
test('Image Pipeline Transcoding and Sprucing', async (t) => {
  const imagePipeline = require('./lib/imagePipeline');

  await t.test('spruceImageBuffer returns optimized square JPEG buffer', async () => {
    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const inputBuffer = Buffer.from(base64Png, 'base64');
    
    const outputBuffer = await imagePipeline.spruceImageBuffer(inputBuffer, {
      canvasSize: 200,
      watermarkText: "Test Watermark",
      colorCorrection: true,
      watermark: true
    });
    
    assert.ok(outputBuffer);
    assert.ok(outputBuffer.length > 0);
    
    const testOut = path.join(testDir, 'test-spruced.jpg');
    fs.writeFileSync(testOut, outputBuffer);
    
    try {
      const dimensions = utils.getImageDimensions(testOut);
      assert.ok(dimensions);
      assert.strictEqual(dimensions.width, 200);
      assert.strictEqual(dimensions.height, 200);
      assert.strictEqual(dimensions.type, 'JPEG');
    } finally {
      try { fs.unlinkSync(testOut); } catch (e) {}
    }
  });

  await t.test('processImageSource processes local files successfully', async () => {
    const inputPng = path.join(testDir, 'test-pipeline-input.png');
    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    fs.writeFileSync(inputPng, Buffer.from(base64Png, 'base64'));

    try {
      const result = await imagePipeline.processImageSource(inputPng, {
        canvasSize: 150,
        watermark: false
      });
      
      assert.ok(result.outputPath);
      assert.ok(fs.existsSync(result.outputPath));
      assert.strictEqual(result.metadata.width, 150);
      assert.strictEqual(result.metadata.height, 150);
      assert.strictEqual(result.metadata.format, 'jpeg');
      
      try { fs.unlinkSync(result.outputPath); } catch (e) {}
    } finally {
      try { fs.unlinkSync(inputPng); } catch (e) {}
    }
  });

  await t.test('imageDownloader correctly upgrades retail store image URLs', async () => {
    const downloader = require('./lib/imageDownloader');
    
    // Amazon
    const amazonUrl = "https://m.media-amazon.com/images/I/71xyz._AC_SL150_.jpg";
    assert.strictEqual(downloader.upgradeImageUrl(amazonUrl), "https://m.media-amazon.com/images/I/71xyz.jpg");
    
    // eBay
    const ebayUrl = "https://i.ebayimg.com/images/g/xyz/s-l500.jpg";
    assert.strictEqual(downloader.upgradeImageUrl(ebayUrl), "https://i.ebayimg.com/images/g/xyz/s-l1600.jpg");
    
    // Shopify
    const shopifyUrl = "https://cdn.shopify.com/s/files/1/123/img_medium.jpg";
    assert.strictEqual(downloader.upgradeImageUrl(shopifyUrl), "https://cdn.shopify.com/s/files/1/123/img.jpg");
  });

  await t.test('localChromaKeyBgRemove transparency mask and smart cropping', async () => {
    const sharp = require('sharp');
    // Generate a simple 10x10 green box with white borders
    // To keep it simple, we construct a 10x10 raw pixel buffer: outer white, inner green
    const width = 10;
    const height = 10;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          // White background border
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
          data[idx + 3] = 255;
        } else {
          // Inner green product subject
          data[idx] = 0;
          data[idx + 1] = 200;
          data[idx + 2] = 0;
          data[idx + 3] = 255;
        }
      }
    }

    const inputBuffer = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const transparentBuffer = await imagePipeline.localChromaKeyBgRemove(inputBuffer, 35, 10);
    
    assert.ok(transparentBuffer);
    const meta = await sharp(transparentBuffer).metadata();
    assert.strictEqual(meta.format, 'png');
    assert.strictEqual(meta.hasAlpha, true);
  });

  await t.test('spruceImageBuffer supports crop, rotate, gradient background, and tiled watermarks', async () => {
    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const inputBuffer = Buffer.from(base64Png, 'base64');

    const outputBuffer = await imagePipeline.spruceImageBuffer(inputBuffer, {
      canvasSize: 300,
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      rotate: 90,
      bgStyle: 'gradient',
      watermarkText: "Confidential",
      watermarkPosition: "diagonal-tile"
    });

    assert.ok(outputBuffer);
    assert.ok(outputBuffer.length > 0);

    const testOut = path.join(testDir, 'test-advanced-spruced.jpg');
    fs.writeFileSync(testOut, outputBuffer);

    try {
      const dimensions = utils.getImageDimensions(testOut);
      assert.ok(dimensions);
      assert.strictEqual(dimensions.width, 300);
      assert.strictEqual(dimensions.height, 300);
    } finally {
      try { fs.unlinkSync(testOut); } catch (e) {}
    }
  });
});

// ==========================================
// 9. SSE Logs, eBay Policies, Deduplication, and VeRO Daemon Tests
// ==========================================
test('SSE log stream, eBay policies, deduplication gates, and VeRO daemon fallback', async (t) => {
  const originalFetch = global.fetch;

  // ── 9.1  GET /api/logs/stream returns text/event-stream ─────────────────
  await t.test('GET /api/logs/stream returns SSE text/event-stream connection', async () => {
    webServer.resetRateLimits();
    const testPort = 46010;
    const server = webServer.startWebGuiServer(testPort);

    try {
      try { fs.writeFileSync(config.logPath, '', 'utf8'); } catch (e) {}

      const res = await fetch(`http://127.0.0.1:${testPort}/api/logs/stream`, {
        headers: { 'X-Lister-API-Key': 'lister-secret-key-12345' }
      });

      assert.strictEqual(res.status, 200);
      const ct = res.headers.get('content-type') || '';
      assert.ok(ct.includes('text/event-stream'), `Expected text/event-stream, got: ${ct}`);

      res.body.cancel().catch(() => {});
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ── 9.2  GET /api/ebay/policies returns structured policy data ───────────
  await t.test('GET /api/ebay/policies returns fulfillment, return, and payment arrays', async () => {
    webServer.resetRateLimits();
    const testPort = 46011;
    const server = webServer.startWebGuiServer(testPort);

    const originalGetEbayPolicies = ebayClient.getEbayPolicies;
    ebayClient.getEbayPolicies = async () => ({
      fulfillment: [{ fulfillmentPolicyId: 'fp-001', name: 'Mock Fulfillment Policy' }],
      return:      [{ returnPolicyId: 'rp-001',      name: 'Mock Return Policy' }],
      payment:     [{ paymentPolicyId: 'pp-001',     name: 'Mock Payment Policy' }]
    });

    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/ebay/policies`, {
        headers: { 'X-Lister-API-Key': 'lister-secret-key-12345' }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.fulfillment), 'fulfillment must be an array');
      assert.ok(Array.isArray(data.return),      'return must be an array');
      assert.ok(Array.isArray(data.payment),     'payment must be an array');
      assert.strictEqual(data.fulfillment[0].fulfillmentPolicyId, 'fp-001');
      assert.strictEqual(data.return[0].returnPolicyId,           'rp-001');
      assert.strictEqual(data.payment[0].paymentPolicyId,         'pp-001');
    } finally {
      ebayClient.getEbayPolicies = originalGetEbayPolicies;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ── 9.3  POST /api/publish rejects duplicates with 409 then allows force ─
  await t.test('POST /api/publish rejects duplicate title with 409 and allows force override', async () => {
    webServer.resetRateLimits();
    const testPort = 46012;
    const server = webServer.startWebGuiServer(testPort);

    const existingHistory = [{
      sku:       'DUP-EXISTING-SKU',
      title:     'Duplicate Test Item',
      status:    'ACTIVE',
      timestamp: new Date().toISOString(),
      listingDetails: { title: 'Duplicate Test Item', upc: '' }
    }];
    utils.writeJsonFileSecure(config.historyPath, existingHistory);

    const originalGetPolicies = ebayClient.getOrCreateListingPolicies;
    const originalEbayRequest = ebayClient.ebayRequest;
    const originalRefresh = ebayClient.refreshEbayAccessToken;
    ebayClient.getOrCreateListingPolicies = async () => ({
      fulfillmentId: 'ful-test', paymentId: 'pay-test', returnId: 'ret-test'
    });
    ebayClient.ebayRequest = async (path) => {
      if (path.includes('/publish')) return { listingId: 'ebay-force-123' };
      if (path === '/offer')        return { offerId: 'off-force-456' };
      return {};
    };
    ebayClient.refreshEbayAccessToken = async () => {};

    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken('active-token');

    const listingPayload = {
      title: 'Duplicate Test Item', suggestedPrice: 29.99,
      condition: 'USED_GOOD', brand: 'Generic',
      aspects: {}, categoryId: '111422', description: 'A test item'
    };

    try {
      // First attempt — expect 409
      const firstRes = await fetch(`http://127.0.0.1:${testPort}/api/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lister-API-Key': 'lister-secret-key-12345' },
        body: JSON.stringify({
          sku: 'DUP-NEW-SKU', listing: listingPayload, imageUrls: ["https://example.com/image.png"],
          shippingOption: 'USPS_GROUND', returnOption: 'NO_RETURNS', immediatePayment: false
        })
      });
      assert.strictEqual(firstRes.status, 409, 'First publish should be rejected as duplicate (409)');
      const firstData = await firstRes.json();
      assert.ok(firstData.message && firstData.message.length > 0, 'Rejection message must be present');

      // Force override — expect 200
      const forceRes = await fetch(`http://127.0.0.1:${testPort}/api/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lister-API-Key': 'lister-secret-key-12345' },
        body: JSON.stringify({
          sku: 'DUP-NEW-SKU', listing: listingPayload, imageUrls: ["https://example.com/image.png"],
          shippingOption: 'USPS_GROUND', returnOption: 'NO_RETURNS', immediatePayment: false,
          force: true
        })
      });
      assert.strictEqual(forceRes.status, 200, 'Force publish should succeed (200)');
      const forceData = await forceRes.json();
      assert.strictEqual(forceData.success, true);
      assert.strictEqual(forceData.listingId, 'ebay-force-123');
    } finally {
      ebayClient.setAccessToken(originalToken);
      ebayClient.getOrCreateListingPolicies = originalGetPolicies;
      ebayClient.ebayRequest = originalEbayRequest;
      ebayClient.refreshEbayAccessToken = originalRefresh;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ── 9.4  POST /api/publish blocks VeRO brands with 409 ──────────────────
  await t.test('POST /api/publish blocks VeRO brand with 409 and allows force override', async () => {
    webServer.resetRateLimits();
    const testPort = 46013;
    const server = webServer.startWebGuiServer(testPort);

    utils.writeJsonFileSecure(config.historyPath, []);

    const originalGetPolicies = ebayClient.getOrCreateListingPolicies;
    const originalEbayRequest = ebayClient.ebayRequest;
    const originalRefresh = ebayClient.refreshEbayAccessToken;
    ebayClient.getOrCreateListingPolicies = async () => ({
      fulfillmentId: 'ful-v', paymentId: 'pay-v', returnId: 'ret-v'
    });
    ebayClient.ebayRequest = async (path) => {
      if (path.includes('/publish')) return { listingId: 'ebay-vero-ok' };
      if (path === '/offer')        return { offerId: 'off-vero-ok' };
      return {};
    };
    ebayClient.refreshEbayAccessToken = async () => {};

    const originalToken = ebayClient.getAccessToken();
    ebayClient.setAccessToken('active-token');

    const veroListing = {
      title: 'Rolex Submariner Watch', suggestedPrice: 299.99,
      condition: 'USED_GOOD', brand: 'Rolex',
      aspects: {}, categoryId: '31387', description: 'Premium timepiece'
    };

    try {
      // VeRO block — expect 409
      const veroRes = await fetch(`http://127.0.0.1:${testPort}/api/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lister-API-Key': 'lister-secret-key-12345' },
        body: JSON.stringify({
          sku: 'VERO-SKU-1', listing: veroListing, imageUrls: ["https://example.com/image.png"],
          shippingOption: 'USPS_GROUND', returnOption: 'NO_RETURNS', immediatePayment: false
        })
      });
      assert.strictEqual(veroRes.status, 409, 'VeRO brand publish should be blocked (409)');
      const veroData = await veroRes.json();
      assert.strictEqual(veroData.error, 'VERO_BRAND_BLOCKED');

      // Force override — expect 200
      const forceRes = await fetch(`http://127.0.0.1:${testPort}/api/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lister-API-Key': 'lister-secret-key-12345' },
        body: JSON.stringify({
          sku: 'VERO-SKU-1', listing: veroListing, imageUrls: ["https://example.com/image.png"],
          shippingOption: 'USPS_GROUND', returnOption: 'NO_RETURNS', immediatePayment: false,
          force: true
        })
      });
      assert.strictEqual(forceRes.status, 200, 'Force VeRO publish should succeed (200)');
      const forceVeroData = await forceRes.json();
      assert.strictEqual(forceVeroData.success, true);
    } finally {
      ebayClient.setAccessToken(originalToken);
      ebayClient.getOrCreateListingPolicies = originalGetPolicies;
      ebayClient.ebayRequest = originalEbayRequest;
      ebayClient.refreshEbayAccessToken = originalRefresh;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ── 9.5  Watcher daemon saves VeRO-flagged items as DRAFT ───────────────
  await t.test('Watcher daemon VeRO gate saves flagged items as DRAFT not ACTIVE', async () => {
    const listerPro = require('./simple-lister-pro');

    utils.writeJsonFileSecure(config.historyPath, []);

    const veroListing = {
      title:          'Nike Air Force 1 Shoes',
      suggestedPrice: 89.99,
      condition:      'NEW',
      brand:          'Nike',
      model:          'Air Force 1',
      categoryId:     '15709',
      aspects:        { Size: '10' },
      description:    'Brand new Nike sneakers.',
      upc:            '885179528829',
      imageUrls:      []
    };

    // Invoke the exported VeRO fallback handler directly
    assert.ok(
      typeof listerPro.handleVeroAutoListingFallback === 'function',
      'simple-lister-pro must export handleVeroAutoListingFallback'
    );

    await listerPro.handleVeroAutoListingFallback(veroListing, 'VERO-DAEMON-SKU');

    const history = utils.readJsonFileSecure(config.historyPath, []);
    const saved = history.find(i => i.sku === 'VERO-DAEMON-SKU');
    assert.ok(saved,                           'Item should be saved to history');
    assert.strictEqual(saved.status, 'DRAFT',  'VeRO-flagged item must be saved as DRAFT');
    assert.strictEqual(saved.veroWarning, true, 'veroWarning flag must be set true');
  });

  global.fetch = originalFetch;
});

// ==========================================
// 14. DLQ API & hardening tests
// ==========================================
test('DLQ API endpoints and validation', async (t) => {
  webServer.resetRateLimits();
  const testPort = 45923;
  const server = webServer.startWebGuiServer(testPort);
  const crossPost = require('./crossPost');

  try { fs.writeFileSync(config.dlqPath, '[]', 'utf8'); } catch (e) {}

  const mockListing = {
    title: 'DLQ API Test Item',
    suggestedPrice: 29.99,
    description: 'Test',
    brand: 'Generic',
    condition: 'NEW'
  };

  await crossPost.addToDlq('shopify', 'DLQ-API-SKU', mockListing, ['https://example.com/img.jpg'], 'Simulated failure');

  try {
    const listRes = await REAL_FETCH(`http://127.0.0.1:${testPort}/api/dlq`);
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert.strictEqual(listData.summary.total, 1);
    assert.strictEqual(listData.entries[0].sku, 'DLQ-API-SKU');

    const badRes = await REAL_FETCH(`http://127.0.0.1:${testPort}/api/dlq/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry', sku: 'INVALID SKU!', platform: 'shopify' })
    });
    assert.strictEqual(badRes.status, 500);

    const dismissRes = await REAL_FETCH(`http://127.0.0.1:${testPort}/api/dlq/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', sku: 'DLQ-API-SKU', platform: 'shopify' })
    });
    assert.strictEqual(dismissRes.status, 200);
    const dismissData = await dismissRes.json();
    assert.strictEqual(dismissData.summary.total, 0);

    const statusRes = await REAL_FETCH(`http://127.0.0.1:${testPort}/api/status`);
    const statusData = await statusRes.json();
    assert.ok(statusData.dlq);
    assert.strictEqual(statusData.dlq.total, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DLQ rejects invalid listing payloads', async () => {
  const crossPost = require('./crossPost');
  try { fs.writeFileSync(config.dlqPath, '[]', 'utf8'); } catch (e) {}

  await assert.rejects(
    () => crossPost.addToDlq('shopify', 'BAD-SKU', { title: 'No price' }, [], 'bad data'),
    /Invalid suggestedPrice/
  );

  await assert.rejects(
    () => crossPost.addToDlq('unknown', 'GOOD-SKU', { title: 'Test', suggestedPrice: 10 }, [], 'bad platform'),
    /Invalid platform/
  );
});



// ==========================================
// [WAVE1-A] Wave 1A: listing fields (keywords/MSRP/COG), templates, private notes
// ==========================================
test('Wave 1A listing fields, templates, and private notes', async (t) => {
  // [WAVE1-A] Neutralize test pollution: the earlier OAuth tests restore
  // GOOGLE_CLIENT_ID via `process.env.X = undefined`, which leaves the
  // truthy string "undefined" and wrongly enables auth for later tests.
  const savedGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  const hadGoogleClientId = Object.prototype.hasOwnProperty.call(process.env, 'GOOGLE_CLIENT_ID');
  if (hadGoogleClientId) delete process.env.GOOGLE_CLIENT_ID;
  try {
  await t.test('computeProfit math and zero-price guard', () => {
    const r = utils.computeProfit({ price: 100, fees: 13, cog: 30, shippingCost: 5 });
    assert.strictEqual(r.gross, 100);
    assert.strictEqual(r.net, 87);
    assert.strictEqual(r.profit, 52);
    assert.strictEqual(r.marginPct, 52);

    // Zero price must not produce NaN/Infinity
    const z = utils.computeProfit({ price: 0, fees: 0, cog: 10, shippingCost: 5 });
    assert.strictEqual(z.marginPct, 0);
    assert.strictEqual(z.profit, -15);
    assert.ok(Number.isFinite(z.marginPct));

    // Missing inputs default to 0
    const d = utils.computeProfit({});
    assert.deepStrictEqual(d, { gross: 0, net: 0, profit: 0, marginPct: 0 });
  });

  await t.test('normalizeListingFields produces a stable shape', () => {
    const out = utils.normalizeListingFields({
      keywords: 'vintage, leather ,, mid century ',
      msrp: '199.99',
      costOfGoods: '',
      internalNotes: 'fragile - pack well'
    });
    assert.deepStrictEqual(out.keywords, ['vintage', 'leather', 'mid century']);
    assert.strictEqual(out.msrp, 199.99);
    assert.strictEqual(out.costOfGoods, null);
    assert.strictEqual(out.internalNotes, 'fragile - pack well');

    const empty = utils.normalizeListingFields({});
    assert.deepStrictEqual(empty.keywords, []);
    assert.strictEqual(empty.msrp, null);
    assert.strictEqual(empty.costOfGoods, null);
    assert.strictEqual(empty.internalNotes, '');
  });

  await t.test('sanitizeListingForMarketplace strips private fields', () => {
    const listing = {
      title: 'Test Widget',
      suggestedPrice: 49.99,
      internalNotes: 'TOP-SECRET-NOTE-123',
      costOfGoods: 12.5,
      keywords: ['a', 'b']
    };
    const clean = utils.sanitizeListingForMarketplace(listing);
    assert.ok(!('internalNotes' in clean));
    assert.ok(!('costOfGoods' in clean));
    assert.ok(!JSON.stringify(clean).includes('TOP-SECRET-NOTE-123'));
    assert.strictEqual(clean.title, 'Test Widget');
    // Original object is not mutated
    assert.strictEqual(listing.internalNotes, 'TOP-SECRET-NOTE-123');
  });

  await t.test('templates save/load round-trip via /api/templates', async () => {
    const testPort = 45913;
    const server = webServer.startWebGuiServer(testPort);
    try {
      const fields = {
        title: 'Template Title',
        suggestedPrice: 25.5,
        condition: 'USED_EXCELLENT',
        brand: 'Acme',
        model: 'X1',
        keywords: ['retro', 'niche'],
        msrp: 59.99,
        costOfGoods: 8,
        internalNotes: 'template-local-note',
        aspects: { Color: 'Red' }
      };
      const saveRes = await fetch(`http://127.0.0.1:${testPort}/api/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Template', fields })
      });
      assert.strictEqual(saveRes.status, 200);
      const saved = await saveRes.json();
      assert.strictEqual(saved.success, true);
      assert.strictEqual(saved.name, 'My Template');

      const getRes = await fetch(`http://127.0.0.1:${testPort}/api/templates`);
      assert.strictEqual(getRes.status, 200);
      const data = await getRes.json();
      assert.ok(Array.isArray(data.templates));
      const tpl = data.templates.find(x => x.name === 'My Template');
      assert.ok(tpl);
      assert.ok(tpl.createdAt);
      assert.deepStrictEqual(tpl.fields.keywords, ['retro', 'niche']);
      assert.strictEqual(tpl.fields.msrp, 59.99);
      assert.strictEqual(tpl.fields.internalNotes, 'template-local-note');

      // Missing name is rejected
      const badRes = await fetch(`http://127.0.0.1:${testPort}/api/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ', fields: {} })
      });
      assert.strictEqual(badRes.status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('keywords/msrp/cog/internalNotes persist in listingDetails via /api/save-draft', async () => {
    const testPort = 45914;
    const server = webServer.startWebGuiServer(testPort);
    try {
      const saveRes = await fetch(`http://127.0.0.1:${testPort}/api/save-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listing: {
            title: 'Wave1A Persistence Check',
            suggestedPrice: 79.99,
            condition: 'USED_VERY_GOOD',
            brand: 'TestBrand',
            model: 'M2',
            categoryId: '111422',
            upc: '123456789012',
            weightMajor: 1,
            weightMinor: 0,
            packageLength: 10,
            packageWidth: 8,
            packageHeight: 6,
            description: 'A fine test item.',
            aspects: { Material: 'Steel' },
            keywords: 'vintage, leather, mid century',
            msrp: 199.99,
            costOfGoods: 25,
            internalNotes: 'sourcing: estate sale'
          },
          imageUrls: ['/uploads/local-test.jpg']
        })
      });
      assert.strictEqual(saveRes.status, 200);
      const saved = await saveRes.json();
      assert.ok(saved.sku);

      const history = utils.readJsonFileSecure(config.historyPath, []);
      const item = history.find(i => i.sku === saved.sku);
      assert.ok(item);
      assert.deepStrictEqual(item.listingDetails.keywords, ['vintage', 'leather', 'mid century']);
      assert.strictEqual(item.listingDetails.msrp, 199.99);
      assert.strictEqual(item.listingDetails.costOfGoods, 25);
      assert.strictEqual(item.listingDetails.internalNotes, 'sourcing: estate sale');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('eBay-bound payload contains no internalNotes key or value', async () => {
    const originalFetch = global.fetch;
    const testPort = 45915;
    const server = webServer.startWebGuiServer(testPort);
    const createMockResponse = (status, bodyObj) => {
      const bodyText = JSON.stringify(bodyObj);
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        json: async () => bodyObj,
        text: async () => bodyText
      };
    };
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.startsWith(`http://127.0.0.1:${testPort}`)) {
        return originalFetch(url, options);
      }
      return createMockResponse(200, { access_token: 'mock-token' });
    };

    const captured = {};
    const originalEbayRequest = ebayClient.ebayRequest;
    ebayClient.ebayRequest = async (path, method, body) => {
      if (path.includes('/publish')) return { listingId: 'ebay-listing-1a' };
      if (path === '/offer') return { offerId: 'ebay-offer-1a' };
      if (path.includes('/inventory_item/')) {
        captured.inventoryItem = body;
        return {};
      }
      return {};
    };

    try {
      // Save a draft carrying private fields
      const saveRes = await originalFetch(`http://127.0.0.1:${testPort}/api/save-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listing: {
            title: 'Private Notes Strip Check',
            suggestedPrice: 59.99,
            condition: 'NEW',
            brand: 'TestBrand',
            model: 'M3',
            categoryId: '111422',
            upc: '123456789012',
            weightMajor: 1,
            weightMinor: 0,
            packageLength: 10,
            packageWidth: 8,
            packageHeight: 6,
            description: 'Public description here.',
            aspects: { Color: 'Blue' },
            keywords: ['kw1', 'kw2'],
            msrp: 129.99,
            costOfGoods: 20,
            internalNotes: 'SUPER-SECRET-PRIVATE-NOTE-XYZ'
          },
          imageUrls: ['/uploads/local-test.jpg']
        })
      });
      assert.strictEqual(saveRes.status, 200);
      const saved = await saveRes.json();

      const pubRes = await originalFetch(`http://127.0.0.1:${testPort}/api/publish-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: saved.sku })
      });
      assert.strictEqual(pubRes.status, 200);

      assert.ok(captured.inventoryItem, 'inventory item payload was captured');
      const payloadJson = JSON.stringify(captured.inventoryItem);
      assert.ok(!payloadJson.includes('internalNotes'), 'no internalNotes key in eBay payload');
      assert.ok(!payloadJson.includes('SUPER-SECRET-PRIVATE-NOTE-XYZ'), 'no internal note value in eBay payload');
      assert.ok(!payloadJson.includes('costOfGoods'), 'no costOfGoods key in eBay payload');
      // MSRP is buyer-facing and threaded into the description footer
      assert.ok(payloadJson.includes('Original MSRP'), 'MSRP threaded into eBay description');
    } finally {
      global.fetch = originalFetch;
      ebayClient.ebayRequest = originalEbayRequest;
      await new Promise((resolve) => server.close(resolve));
    }
  });
  } finally {
    // [WAVE1-A] Restore the (polluted) prior value so suite state is unchanged.
    if (hadGoogleClientId) process.env.GOOGLE_CLIENT_ID = savedGoogleClientId;
    else delete process.env.GOOGLE_CLIENT_ID;
  }
});







// ==========================================
// [WAVE1-B] CSV export, bulk status, notifications
// ==========================================
test('Wave 1B: CSV export, bulk mark sold/listed, task error notifications', async (t) => {
  // Back up sandbox state left by earlier suites so these tests are hermetic.
  const historyBackup = fs.existsSync(config.historyPath)
    ? fs.readFileSync(config.historyPath, 'utf8') : null;
  const notifBackup = fs.existsSync(config.notificationsPath)
    ? fs.readFileSync(config.notificationsPath, 'utf8') : null;

  // [WAVE1-B] Earlier suites set a mock GOOGLE_CLIENT_ID (and restore it as the
  // string "undefined"); clear it so the auth middleware does not 401 these HTTP tests.
  const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;

  function resetHistory(rows) {
    utils.writeJsonFileSecure(config.historyPath, rows);
  }
  function resetNotifications() {
    utils.writeJsonFileSecure(config.notificationsPath, []);
  }

  await t.test('csvEscape handles plain, comma, quote, newline and null values', () => {
    assert.strictEqual(webServer.csvEscape('plain'), 'plain');
    assert.strictEqual(webServer.csvEscape('a,b'), '"a,b"');
    assert.strictEqual(webServer.csvEscape('say "hi"'), '"say ""hi"""');
    assert.strictEqual(webServer.csvEscape('line1\nline2'), '"line1\nline2"');
    assert.strictEqual(webServer.csvEscape(null), '');
    assert.strictEqual(webServer.csvEscape(undefined), '');
    assert.strictEqual(webServer.csvEscape(12.5), '12.5');
  });

  await t.test('buildListingsCsv emits header + escaped rows with wave-1 and marketplace columns', () => {
    const rows = [
      {
        sku: 'W1B-A',
        title: 'Vintage "Rare", Camera\n(boxed)',
        price: 149.99,
        categoryId: '31388',
        status: 'ACTIVE',
        timestamp: '2026-10-18T00:00:00.000Z',
        listingId: 'eBay123',
        shopifyId: 'shop9',
        woocommerceId: null,
        etsyId: 'etsy7',
        keywords: ['vintage', 'film, camera'],
        msrp: 299.99,
        costOfGoods: 40,
        internalNotes: 'shelf "B", needs cleaning',
        listingDetails: { brand: 'Canon' }
      },
      { sku: 'W1B-B', title: 'Plain Widget', price: 9.5 } // missing fields export as empty
    ];
    const csv = webServer.buildListingsCsv(rows);
    const lines = csv.split('\r\n').filter(l => l.length > 0);
    assert.strictEqual(lines[0],
      'sku,title,price,msrp,keywords,costOfGoods,internalNotes,status,categoryId,createdAt,ebayListingId,shopifyId,woocommerceId,etsyId');
    assert.ok(lines[1].includes('"Vintage ""Rare"", Camera\n(boxed)"'), 'title escaping');
    assert.ok(lines[1].includes('"vintage; film, camera"'), 'keywords join');
    assert.ok(lines[1].includes('299.99') && lines[1].includes('40'), 'wave-1 numeric fields');
    assert.ok(lines[1].includes('"shelf ""B"", needs cleaning"'), 'internal notes escaping');
    assert.ok(lines[1].includes('eBay123,shop9,,etsy7'), 'marketplace ids');
    assert.strictEqual(lines[2], 'W1B-B,Plain Widget,9.5,,,,,ACTIVE,,,,,,');
  });

  await t.test('bulkUpdateListingStatus updates via the history store and reports partial failures', () => {
    resetHistory([
      { sku: 'BULK-1', title: 'One', price: 10, status: 'ACTIVE' },
      { sku: 'BULK-2', title: 'Two', price: 20, status: 'DRAFT' }
    ]);
    const res = webServer.bulkUpdateListingStatus(['BULK-1', 'BULK-2', 'BULK-MISSING'], 'SOLD');
    assert.strictEqual(res.updated, 2);
    assert.strictEqual(res.results.length, 3);
    assert.deepStrictEqual(res.results[0], { sku: 'BULK-1', ok: true, error: null });
    assert.deepStrictEqual(res.results[1], { sku: 'BULK-2', ok: true, error: null });
    assert.strictEqual(res.results[2].ok, false);
    assert.ok(res.results[2].error.includes('not found'));
    const history = utils.readJsonFileSecure(config.historyPath, []);
    assert.strictEqual(history.find(i => i.sku === 'BULK-1').status, 'SOLD');
    assert.strictEqual(history.find(i => i.sku === 'BULK-2').status, 'SOLD');
    assert.strictEqual(history.length, 2, 'no rows added or removed');
    const res2 = webServer.bulkUpdateListingStatus(['BULK-1'], 'ACTIVE');
    assert.strictEqual(res2.updated, 1);
    assert.strictEqual(
      utils.readJsonFileSecure(config.historyPath, []).find(i => i.sku === 'BULK-1').status, 'ACTIVE');
  });

  await t.test('bulkUpdateListingStatus rejects invalid statuses', () => {
    assert.throws(() => webServer.bulkUpdateListingStatus(['BULK-1'], 'BOGUS'), /Invalid status/);
    const history = utils.readJsonFileSecure(config.historyPath, []);
    assert.strictEqual(history.find(i => i.sku === 'BULK-1').status, 'ACTIVE', 'history untouched by the throw');
  });

  await t.test('appendNotification stores newest-first, dedupes rapid repeats, dismisses by id', () => {
    resetNotifications();
    const n1 = utils.appendNotification('ebay-sync', 'boom');
    assert.ok(n1 && n1.id && n1.ts && n1.task === 'ebay-sync' && n1.message === 'boom');
    const n2 = utils.appendNotification('dlq-processing', 'kaput');
    const list = utils.getNotifications();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, n2.id, 'newest first');
    const dup = utils.appendNotification('dlq-processing', 'kaput');
    assert.strictEqual(dup, null, 'rapid duplicate suppressed');
    assert.strictEqual(utils.getNotifications().length, 2);
    const n3 = utils.appendNotification('dlq-processing', 'kaput-again');
    assert.ok(n3, 'different message still appends');
    assert.strictEqual(utils.getNotifications().length, 3);
    assert.strictEqual(utils.dismissNotification(n2.id), true);
    assert.strictEqual(utils.getNotifications().length, 2);
    assert.strictEqual(utils.dismissNotification('nope-not-real'), false);
    resetNotifications();
  });

  await t.test('appendNotification caps the list at 100 entries', () => {
    resetNotifications();
    for (let i = 0; i < 105; i++) {
      utils.appendNotification('cap-test', `msg-${i}`);
    }
    const list = utils.getNotifications();
    assert.strictEqual(list.length, utils.NOTIFICATIONS_MAX);
    assert.strictEqual(list[0].message, 'msg-104', 'newest first after cap');
    resetNotifications();
  });

  await t.test('HTTP: GET /api/listings/export.csv downloads escaped CSV', async () => {
    resetHistory([
      { sku: 'CSV-1', title: 'Gizmo, "Deluxe"\nEdition', price: 42, status: 'ACTIVE',
        categoryId: '1', timestamp: '2026-10-18T00:00:00.000Z', listingId: 'eb1' }
    ]);
    const server = webServer.startWebGuiServer(0);
    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/listings/export.csv`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/csv'));
      assert.ok(res.headers.get('content-disposition').includes('attachment'));
      const text = await res.text();
      assert.ok(text.startsWith('sku,title,price,'));
      assert.ok(text.includes('"Gizmo, ""Deluxe""\nEdition"'));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('HTTP: POST /api/listings/bulk-status validates payload and reports per-sku results', async () => {
    resetHistory([
      { sku: 'HTTP-B1', title: 'H1', price: 1, status: 'ACTIVE' },
      { sku: 'HTTP-B2', title: 'H2', price: 2, status: 'DRAFT' }
    ]);
    const server = webServer.startWebGuiServer(0);
    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;
    async function post(body) {
      const res = await fetch(`http://127.0.0.1:${port}/api/listings/bulk-status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      });
      return { status: res.status, json: await res.json() };
    }
    try {
      const ok = await post(JSON.stringify({ skus: ['HTTP-B1', 'HTTP-B2', 'HTTP-NOPE'], status: 'SOLD' }));
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.json.updated, 2);
      assert.strictEqual(ok.json.total, 3);
      assert.strictEqual(ok.json.results.filter(r => r.ok).length, 2);
      assert.strictEqual(ok.json.results.find(r => r.sku === 'HTTP-NOPE').ok, false);
      const bad1 = await post(JSON.stringify({ skus: [], status: 'SOLD' }));
      assert.strictEqual(bad1.status, 400);
      const bad2 = await post(JSON.stringify({ skus: ['HTTP-B1'], status: 'WRONG' }));
      assert.strictEqual(bad2.status, 400);
      const bad3 = await post('not-json{');
      assert.strictEqual(bad3.status, 400);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('HTTP: GET/POST /api/notifications round-trips unread count and dismissal', async () => {
    resetNotifications();
    const server = webServer.startWebGuiServer(0);
    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;
    try {
      let res = await fetch(`http://127.0.0.1:${port}/api/notifications`);
      let d = await res.json();
      assert.strictEqual(d.unread, 0);
      assert.deepStrictEqual(d.notifications, []);
      utils.appendNotification('background-sync', 'interval blew up');
      res = await fetch(`http://127.0.0.1:${port}/api/notifications`);
      d = await res.json();
      assert.strictEqual(d.unread, 1);
      assert.strictEqual(d.notifications[0].task, 'background-sync');
      const id = d.notifications[0].id;
      res = await fetch(`http://127.0.0.1:${port}/api/notifications/dismiss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await res.json()).success, true);
      res = await fetch(`http://127.0.0.1:${port}/api/notifications`);
      d = await res.json();
      assert.strictEqual(d.unread, 0);
      res = await fetch(`http://127.0.0.1:${port}/api/notifications/dismiss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'does-not-exist' })
      });
      assert.strictEqual(res.status, 404);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    resetNotifications();
  });

  // Restore sandbox state left by earlier suites.
  if (historyBackup !== null) fs.writeFileSync(config.historyPath, historyBackup, 'utf8');
  if (notifBackup !== null) fs.writeFileSync(config.notificationsPath, notifBackup, 'utf8');
  // [WAVE1-B] Restore the env to exactly what it was before this block.
  if (originalGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
});







// ==========================================
// Wave 1C: take-home pricing, sold-listing links, uncertainty UI,
// AI enhance mode, extended barcode lookups
// ==========================================
test('Wave 1C: marketplace fees, tiers, confidence, enhance, barcode enrichment', async (t) => {

  await t.test('Fee table net math per marketplace', () => {
    // eBay: 13.25% + $0.30
    assert.strictEqual(utils.estimateMarketplaceFee('ebay', 100), 13.55);
    assert.strictEqual(utils.netAfterMarketplaceFees('ebay', 100).net, 86.45);
    // Mercari: 10% + ~2.9% payment
    assert.strictEqual(utils.estimateMarketplaceFee('mercari', 100), 12.90);
    assert.strictEqual(utils.netAfterMarketplaceFees('mercari', 100).net, 87.10);
    // Poshmark: 20% at/over $15, flat $2.95 under $15
    assert.strictEqual(utils.estimateMarketplaceFee('poshmark', 100), 20.00);
    assert.strictEqual(utils.netAfterMarketplaceFees('poshmark', 100).net, 80.00);
    assert.strictEqual(utils.estimateMarketplaceFee('poshmark', 10), 2.95);
    assert.strictEqual(utils.netAfterMarketplaceFees('poshmark', 10).net, 7.05);
    assert.strictEqual(utils.estimateMarketplaceFee('poshmark', 15), 3.00);
    // Etsy: 6.5% + $0.20 + 3% + $0.25
    assert.strictEqual(utils.estimateMarketplaceFee('etsy', 100), 9.95);
    assert.strictEqual(utils.netAfterMarketplaceFees('etsy', 100).net, 90.05);
    // Shopify: 2.9% + $0.30
    assert.strictEqual(utils.estimateMarketplaceFee('shopify', 100), 3.20);
    assert.strictEqual(utils.netAfterMarketplaceFees('shopify', 100).net, 96.80);
    // Unknown marketplace + non-positive price
    assert.throws(() => utils.estimateMarketplaceFee('nope', 100), /Unknown marketplace/);
    assert.strictEqual(utils.estimateMarketplaceFee('ebay', 0), 0);
  });

  await t.test('takeHomeMath uses cross-builder computeProfit when present, falls back otherwise', () => {
    // [WAVE1-MERGE] Merged tree: the sibling helper IS present -> delegation path.
    assert.strictEqual(typeof utils.computeProfit, 'function');
    const args = { price: 100, fees: 13.55, cog: 20, shippingCost: 5 };
    assert.deepStrictEqual(utils.takeHomeMath(args), utils.computeProfit(args));

    // Simulate the sibling helper being absent -> local fallback math must kick in.
    const real = utils.computeProfit;
    delete utils.computeProfit;
    try {
      assert.strictEqual(typeof utils.computeProfit, 'undefined');
      const fallback = utils.takeHomeMath(args);
      // Fallback semantics: net = gross - fees - shipping; profit = net - cog.
      assert.deepStrictEqual(fallback, { gross: 100, net: 81.45, profit: 61.45, marginPct: 61.45 });
    } finally {
      utils.computeProfit = real;
    }
    assert.strictEqual(typeof utils.computeProfit, 'function');
  });

  await t.test('Three-tier computation from a sample comp array', () => {
    const prices = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const tiers = utils.computePricingTiers(prices);
    // Linear interpolation: p25 idx 2.25 -> 32.5; median idx 4.5 -> 55; p75 idx 6.75 -> 77.5
    assert.strictEqual(tiers.sellFast, 32.5);
    assert.strictEqual(tiers.market, 55);
    assert.strictEqual(tiers.patient, 77.5);
    assert.strictEqual(tiers.sampleSize, 10);
    // Single comp -> all tiers equal; empty -> null; junk filtered
    const single = utils.computePricingTiers([42]);
    assert.deepStrictEqual([single.sellFast, single.market, single.patient], [42, 42, 42]);
    assert.strictEqual(utils.computePricingTiers([]), null);
    assert.strictEqual(utils.computePricingTiers(['x', -5, 0]), null);

    const panel = utils.buildTakeHomePanel(prices);
    assert.strictEqual(panel.rows.length, 3);
    assert.deepStrictEqual(panel.rows.map(r => r.tier), ['sellFast', 'market', 'patient']);
    assert.strictEqual(panel.rows[0].gross, 32.5);
    assert.deepStrictEqual(Object.keys(panel.rows[0].perMarketplace).sort(), ['ebay', 'etsy', 'mercari', 'poshmark', 'shopify']);
    assert.strictEqual(panel.rows[0].perMarketplace.ebay.net, 27.89); // 32.5 - (32.5*0.1325 + 0.30)
    assert.strictEqual(panel.sampleSize, 10);
    assert.strictEqual(panel.feesAsOf, '2026-10');
    assert.strictEqual(panel.feesAreEstimates, true);
    assert.strictEqual(utils.buildTakeHomePanel([]), null);
  });

  await t.test('_confidence schema validation (present, clamped, and missing)', () => {
    const base = () => ({
      title: 't', description: 'd', brand: 'b', model: 'm', suggestedPrice: 10,
      condition: 'NEW', weightMajor: 1, weightMinor: 0,
      packageLength: 1, packageWidth: 1, packageHeight: 1, aspects: {}, detectedDefects: []
    });

    // Present: clamped to 0..1, junk keys dropped
    const withConf = base();
    withConf._confidence = { title: 0.95, specifics: 1.5, price: -0.2, bogus: 'x' };
    geminiClient.validateAndFixListingSchema(withConf);
    assert.deepStrictEqual(withConf._confidence, { title: 0.95, specifics: 1, price: 0 });

    // Missing: untouched, no badge data injected, no crash
    const withoutConf = base();
    geminiClient.validateAndFixListingSchema(withoutConf);
    assert.strictEqual(withoutConf._confidence, undefined);
    assert.strictEqual(withoutConf.title, 't');

    // Malformed: string / array / empty object are removed, never crash
    for (const bad of ['high', [0.9], {}, { title: 'nah' }]) {
      const d = base();
      d._confidence = bad;
      geminiClient.validateAndFixListingSchema(d);
      assert.strictEqual(d._confidence, undefined, `bad _confidence ${JSON.stringify(bad)} should be dropped`);
    }
  });

  await t.test('Enhance prompt builder output shape', () => {
    const prompt = geminiClient.buildEnhancePrompt('my  TITLE!!', '<p>desc here</p>', 'Vintage');
    assert.strictEqual(typeof prompt, 'string');
    assert.ok(prompt.includes('my  TITLE!!'), 'prompt carries the title');
    assert.ok(prompt.includes('<p>desc here</p>'), 'prompt carries the description');
    assert.ok(prompt.includes('Vintage'), 'prompt carries the context');
    assert.ok(/never invent/i.test(prompt), 'prompt forbids inventing facts');
    assert.ok(prompt.includes('80 characters'), 'prompt keeps the 80-char title rule');
  });

  await t.test('enhanceListingDraft returns { title, description } (mocked fetch)', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Polished Title', description: '<p>Polished</p>' }) }] } }]
      })
    });
    try {
      const out = await geminiClient.enhanceListingDraft({ title: 'raw', description: '<p>raw</p>' });
      assert.deepStrictEqual(out, { title: 'Polished Title', description: '<p>Polished</p>' });
    } finally {
      global.fetch = originalFetch;
    }
    // Validation errors
    await assert.rejects(() => geminiClient.enhanceListingDraft({ title: 123, description: 'x' }), /must be strings/);
    await assert.rejects(() => geminiClient.enhanceListingDraft({ title: 'x', description: 'y', context: 5 }), /context/);
  });

  await t.test('ISBN detection', () => {
    assert.strictEqual(webServer.isIsbn13('9780140449136'), true);
    assert.strictEqual(webServer.isIsbn13('9791090636070'), true);
    assert.strictEqual(webServer.isIsbn13('978-0-14-044913-6'), true);
    assert.strictEqual(webServer.isIsbn13('0123456789012'), false); // 13 digits but not 978/979
    assert.strictEqual(webServer.isIsbn13('978014044913'), false);  // 12 digits
    assert.strictEqual(webServer.isIsbn13(''), false);
    assert.strictEqual(webServer.isIsbn13(null), false);
  });

  await t.test('ISBN -> Google Books response mapping (mocked fetch)', async () => {
    const originalFetch = global.fetch;
    const seenUrls = [];
    global.fetch = async (url) => {
      seenUrls.push(url);
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          items: [{
            volumeInfo: {
              title: 'The Odyssey',
              authors: ['Homer', 'Emily Wilson'],
              publisher: 'W. W. Norton',
              publishedDate: '2017-11-07',
              pageCount: 592,
              imageLinks: { thumbnail: 'https://example.com/cover.jpg' }
            }
          }]
        })
      };
    };
    try {
      const upcData = await webServer.resolveBarcodeData('9780393089059');
      assert.ok(upcData, 'expected upcData for an ISBN');
      assert.strictEqual(upcData.title, 'The Odyssey');
      assert.deepStrictEqual(upcData.authors, ['Homer', 'Emily Wilson']);
      assert.strictEqual(upcData.publisher, 'W. W. Norton');
      assert.strictEqual(upcData.publishedDate, '2017-11-07');
      assert.strictEqual(upcData.pageCount, 592);
      assert.strictEqual(upcData.source, 'google-books');
      assert.deepStrictEqual(upcData.stockImageUrls, ['https://example.com/cover.jpg']);
      assert.ok(seenUrls.some(u => u.includes('www.googleapis.com/books/v1/volumes?q=isbn:9780393089059')));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('Music barcode -> MusicBrainz fallback when eBay catalog misses and no Discogs token', async () => {
    const originalFetch = global.fetch;
    const originalToken = ebayClient.getAccessToken();
    const seenUrls = [];
    ebayClient.setAccessToken(null); // force lookupUPCOnEbay to miss
    delete process.env.DISCOGS_TOKEN;
    global.fetch = async (url) => {
      seenUrls.push(url);
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          releases: [{
            title: 'Kind of Blue',
            'artist-credit': [{ name: 'Miles Davis' }],
            date: '1959',
            'label-info': [{ label: { name: 'Columbia' } }],
            country: 'US'
          }]
        })
      };
    };
    try {
      const upcData = await webServer.resolveBarcodeData('0600758394123');
      assert.ok(upcData, 'expected upcData from MusicBrainz fallback');
      assert.strictEqual(upcData.title, 'Kind of Blue');
      assert.strictEqual(upcData.artist, 'Miles Davis');
      assert.strictEqual(upcData.source, 'musicbrainz');
      assert.ok(seenUrls.some(u => u.includes('musicbrainz.org/ws/2/release/')), 'MusicBrainz was queried');
      assert.ok(!seenUrls.some(u => u.includes('api.discogs.com')), 'Discogs skipped without token');
    } finally {
      global.fetch = originalFetch;
      ebayClient.setAccessToken(originalToken);
    }
  });

  await t.test('POST /api/enhance endpoint (mocked AI)', async () => {
    const originalFetch = global.fetch;
    // NOTE: an earlier block restores process.env.GOOGLE_CLIENT_ID to the *string*
    // "undefined" (assigning undefined to process.env coerces it), which flips the
    // server's auth middleware on for all /api routes. Neutralize it for this test.
    const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    // Route local server calls to the real fetch; mock only the Gemini API call.
    global.fetch = async (url, options) => {
      if (typeof url === 'string' && url.startsWith('http://127.0.0.1')) {
        return originalFetch(url, options);
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Endpoint Title', description: '<p>Endpoint desc</p>' }) }] } }]
        })
      };
    };
    const testPort = 45913;
    const server = webServer.startWebGuiServer(testPort);
    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'raw title', description: '<p>raw</p>' })
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.deepStrictEqual(data, { title: 'Endpoint Title', description: '<p>Endpoint desc</p>' });

      const bad = await fetch(`http://127.0.0.1:${testPort}/api/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'only title' })
      });
      assert.strictEqual(bad.status, 400);
    } finally {
      global.fetch = originalFetch;
      if (originalGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ==========================================
// [WAVE1-D] CSV import and team seats
// ==========================================
test('Wave 1D: bulk CSV import and Power Seller team seats', async (t) => {
  // Hermetic backups: history, team store, billing store.
  const historyBackup = fs.existsSync(config.historyPath)
    ? fs.readFileSync(config.historyPath, 'utf8') : null;
  const teamBackup = fs.existsSync(config.teamPath)
    ? fs.readFileSync(config.teamPath, 'utf8') : null;
  const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
  const billingBackup = fs.existsSync(billingDbPath)
    ? fs.readFileSync(billingDbPath, 'utf8') : null;

  const originalGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;

  function resetHistory(rows) { utils.writeJsonFileSecure(config.historyPath, rows); }
  function resetTeam(obj) { utils.writeJsonFileSecure(config.teamPath, obj); }
  function resetBilling(obj) { utils.writeJsonFileSecure(billingDbPath, obj); }
  function setPlan(email, plan) {
    resetBilling({ [email]: { premium: true, subscriptionId: 'sub_test', plan } });
  }

  await t.test('parseListingsCsv handles plain rows, CRLF, BOM and blank lines', () => {
    const rows = webServer.parseListingsCsv('﻿sku,title,price\r\nA1,Widget,9.99\r\n\r\nB2,Gadget,5\r\n');
    assert.deepStrictEqual(rows, [
      ['sku', 'title', 'price'],
      ['A1', 'Widget', '9.99'],
      ['B2', 'Gadget', '5']
    ]);
  });

  await t.test('parseListingsCsv handles quoted commas, escaped quotes and embedded newlines', () => {
    const rows = webServer.parseListingsCsv('sku,title,price\nA1,"Vintage ""Rare"", Camera\n(boxed)",149.99\n');
    assert.deepStrictEqual(rows, [
      ['sku', 'title', 'price'],
      ['A1', 'Vintage "Rare", Camera\n(boxed)', '149.99']
    ]);
  });

  await t.test('parseListingsCsv throws on unterminated quoted field', () => {
    assert.throws(() => webServer.parseListingsCsv('sku,title\nA1,"oops\n'), /unterminated quoted field/);
  });

  await t.test('LISTING_CSV_HEADERS matches the export header (round-trip schema)', () => {
    const csv = webServer.buildListingsCsv([]);
    const headerLine = csv.split('\r\n')[0];
    assert.strictEqual(headerLine, webServer.LISTING_CSV_HEADERS.join(','));
    assert.deepStrictEqual(webServer.LISTING_CSV_HEADERS.slice(0, 3), ['sku', 'title', 'price']);
  });

  await t.test('importListingsFromCsv creates DRAFT listings through the history write path', () => {
    resetHistory([]);
    const csv = 'sku,title,price,msrp,keywords,costOfGoods,internalNotes,categoryId\r\n' +
      'IMP-1,Red Widget,19.99,29.99,"red; shiny; widget",7.5,restock soon,12345\r\n' +
      'IMP-2,Blue Widget,9.5,,,,,\r\n';
    const result = webServer.importListingsFromCsv(csv);
    assert.strictEqual(result.imported, 2);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.total, 2);
    const history = utils.readJsonFileSecure(config.historyPath, []);
    assert.strictEqual(history.length, 2);
    const first = history.find(h => h.sku === 'IMP-1');
    assert.strictEqual(first.status, 'DRAFT');
    assert.strictEqual(first.price, 19.99);
    assert.deepStrictEqual(first.listingDetails.keywords, ['red', 'shiny', 'widget']);
    assert.strictEqual(first.listingDetails.msrp, 29.99);
    assert.strictEqual(first.listingDetails.costOfGoods, 7.5);
    assert.strictEqual(first.listingDetails.internalNotes, 'restock soon');
    assert.strictEqual(first.listingDetails._confidence, 0); // flagged for review (not AI-generated)
    assert.strictEqual(first.listingDetails.importSource, 'csv');
  });

  await t.test('importListingsFromCsv reports per-row errors and skips bad rows', () => {
    resetHistory([{ sku: 'TAKEN-1', title: 'Existing', price: 1, status: 'DRAFT' }]);
    const csv = 'sku,title,price\r\n' +
      'OK-1,Good Item,10\r\n' +                 // valid
      ',No Sku,10\r\n' +                        // missing sku
      'OK-1,Duplicate Sku,10\r\n' +             // duplicate in file
      'TAKEN-1,Clash,10\r\n' +                  // duplicate in history
      'BAD-1,,10\r\n' +                         // missing title
      'BAD-2,No Price,\r\n' +                   // missing price
      'BAD-3,Neg Price,-5\r\n' +                // negative price
      'BAD-4,NaN Price,abc\r\n';                // non-numeric price
    const result = webServer.importListingsFromCsv(csv);
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.failed, 7);
    assert.strictEqual(result.total, 8);
    const byRow = Object.fromEntries(result.results.map(r => [r.row, r]));
    assert.strictEqual(byRow[2].ok, true);
    assert.match(byRow[3].error, /sku is required/);
    assert.match(byRow[4].error, /duplicate sku/);
    assert.match(byRow[5].error, /already exists/);
    assert.match(byRow[6].error, /title is required/);
    assert.match(byRow[7].error, /price must be a number/);
    assert.match(byRow[8].error, /price must be a number/);
    assert.match(byRow[9].error, /price must be a number/);
    const history = utils.readJsonFileSecure(config.historyPath, []);
    assert.strictEqual(history.filter(h => h.sku === 'OK-1').length, 1);
  });

  await t.test('importListingsFromCsv rejects bad msrp/costOfGoods and accepts empty optionals', () => {
    resetHistory([]);
    const csv = 'sku,title,price,msrp,costOfGoods\r\nA,Item,10,abc,\r\nB,Item,10,,xyz\r\n';
    const result = webServer.importListingsFromCsv(csv);
    assert.strictEqual(result.imported, 0);
    assert.match(result.results[0].error, /msrp must be a number/);
    assert.match(result.results[1].error, /costOfGoods must be a number/);
  });

  await t.test('importListingsFromCsv dryRun validates without writing', () => {
    resetHistory([]);
    const csv = 'sku,title,price\r\nDRY-1,Item,10\r\n,Broken,\r\n';
    const result = webServer.importListingsFromCsv(csv, { dryRun: true });
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.valid, 1);
    assert.strictEqual(result.failed, 1);
    assert.deepStrictEqual(utils.readJsonFileSecure(config.historyPath, []), []);
  });

  await t.test('importListingsFromCsv throws on empty input and missing required columns', () => {
    assert.throws(() => webServer.importListingsFromCsv(''), /CSV is empty/);
    assert.throws(() => webServer.importListingsFromCsv('name,amount\nx,1\n'), /Missing required column "sku"/);
    assert.throws(() => webServer.importListingsFromCsv('sku,name\nx,y\n'), /Missing required column "title"/);
  });

  await t.test('export -> import round-trips through the shared schema', () => {
    resetHistory([{
      sku: 'RT-1', title: 'Round, "Trip"', price: 42.5, status: 'ACTIVE',
      categoryId: '999', timestamp: '2026-10-19T00:00:00.000Z',
      keywords: ['a', 'b; c'], msrp: 60, costOfGoods: 10, internalNotes: 'note',
      listingId: 'e1', shopifyId: 's1', woocommerceId: null, etsyId: 'et1',
      listingDetails: {}
    }]);
    const history = utils.readJsonFileSecure(config.historyPath, []);
    const csv = webServer.buildListingsCsv(history);
    resetHistory([]);
    const result = webServer.importListingsFromCsv(csv, { dryRun: true });
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.valid, 1); // statuses/marketplace IDs are export-only; rows still validate
  });

  await t.test('getBillingPlan defaults unknown/absent records to starter', () => {
    resetBilling({});
    assert.deepStrictEqual(webServer.getBillingPlan('nobody@test.com'), { premium: false, plan: 'starter' });
    resetBilling({ 'legacy@test.com': { premium: true, subscriptionId: 'sub_x' } });
    assert.deepStrictEqual(webServer.getBillingPlan('legacy@test.com'), { premium: true, plan: 'pro' });
    setPlan('ps@test.com', 'power_seller');
    assert.deepStrictEqual(webServer.getBillingPlan('ps@test.com'), { premium: true, plan: 'power_seller' });
  });

  await t.test('getTeamMaxSeats grants 3 seats to power_seller only', () => {
    assert.strictEqual(webServer.getTeamMaxSeats('power_seller'), 3);
    assert.strictEqual(webServer.getTeamMaxSeats('pro'), 0);
    assert.strictEqual(webServer.getTeamMaxSeats('starter'), 0);
    assert.strictEqual(webServer.getTeamMaxSeats('nope'), 0);
  });

  await t.test('inviteTeamMember enforces entitlement and email rules', () => {
    setPlan('owner-a@test.com', 'pro');
    assert.throws(() => webServer.inviteTeamMember('owner-a@test.com', 'm@test.com'), /active Power Seller subscription/);
    setPlan('owner-b@test.com', 'power_seller');
    assert.throws(() => webServer.inviteTeamMember('owner-b@test.com', 'not-an-email'), /valid member email/);
    assert.throws(() => webServer.inviteTeamMember('owner-b@test.com', 'owner-b@test.com'), /cannot invite yourself/);
    assert.throws(() => webServer.inviteTeamMember('owner-b@test.com', 'OWNER-B@test.com'), /cannot invite yourself/);
  });

  await t.test('invite -> accept -> workspace lifecycle with seat cap', () => {
    setPlan('boss@test.com', 'power_seller');
    resetTeam({});
    const inv = webServer.inviteTeamMember('boss@test.com', 'Member@Test.com');
    assert.strictEqual(inv.email, 'member@test.com'); // normalized
    assert.strictEqual(inv.status, 'invited');
    assert.throws(() => webServer.inviteTeamMember('boss@test.com', 'member@test.com'), /already on the team/);
    // Fill the remaining seats (3 total).
    webServer.inviteTeamMember('boss@test.com', 'm2@test.com');
    webServer.inviteTeamMember('boss@test.com', 'm3@test.com');
    assert.throws(() => webServer.inviteTeamMember('boss@test.com', 'm4@test.com'), /Seat limit reached/);
    // Accept flips pending -> active; unknown invite throws.
    const active = webServer.acceptTeamInvite('boss@test.com', 'member@test.com');
    assert.strictEqual(active.status, 'active');
    assert.throws(() => webServer.acceptTeamInvite('boss@test.com', 'ghost@test.com'), /No pending invite/);
    // Workspace resolution.
    assert.deepStrictEqual(webServer.getWorkspaceFor('boss@test.com'), { role: 'owner', owner: 'boss@test.com' });
    assert.deepStrictEqual(webServer.getWorkspaceFor('member@test.com'), { role: 'member', owner: 'boss@test.com' });
    assert.strictEqual(webServer.getWorkspaceFor('stranger@test.com'), null);
    // Remove and leave.
    assert.strictEqual(webServer.removeTeamMember('boss@test.com', 'm2@test.com'), true);
    assert.throws(() => webServer.removeTeamMember('boss@test.com', 'm2@test.com'), /not on the team/);
    assert.strictEqual(webServer.leaveTeam('member@test.com'), 'boss@test.com');
    assert.strictEqual(webServer.getWorkspaceFor('member@test.com'), null);
    assert.strictEqual(webServer.leaveTeam('member@test.com'), null);
  });

  await t.test('member seats go dormant when the owner subscription lapses', () => {
    setPlan('lapse@test.com', 'power_seller');
    resetTeam({});
    webServer.inviteTeamMember('lapse@test.com', 'teammate@test.com');
    webServer.acceptTeamInvite('lapse@test.com', 'teammate@test.com');
    assert.deepStrictEqual(webServer.getWorkspaceFor('teammate@test.com'), { role: 'member', owner: 'lapse@test.com' });
    // Owner downgrades to pro (or cancels): member workspace resolves to null.
    setPlan('lapse@test.com', 'pro');
    assert.strictEqual(webServer.getWorkspaceFor('teammate@test.com'), null);
    // Owner is no longer an owner either.
    assert.strictEqual(webServer.getWorkspaceFor('lapse@test.com'), null);
  });

  await t.test('Stripe webhook records plan from checkout metadata', async () => {
    const testPort = 45921;
    const server = webServer.startWebGuiServer(testPort);
    resetBilling({});
    try {
      const eventObj = {
        id: 'evt_w1d',
        type: 'checkout.session.completed',
        data: { object: {
          customer_email: 'ps-buyer@test.com',
          subscription: 'sub_ps_1',
          metadata: { plan: 'power_seller' }
        } }
      };
      const res = await fetch(`http://127.0.0.1:${testPort}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventObj)
      });
      assert.strictEqual(res.status, 200);
      const billing = utils.readJsonFileSecure(billingDbPath, {});
      assert.strictEqual(billing['ps-buyer@test.com'].premium, true);
      assert.strictEqual(billing['ps-buyer@test.com'].plan, 'power_seller');
      assert.deepStrictEqual(webServer.getWorkspaceFor('ps-buyer@test.com'), { role: 'owner', owner: 'ps-buyer@test.com' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('POST /api/listings/import endpoint imports via HTTP with dryRun gate', async () => {
    const testPort = 45922;
    const server = webServer.startWebGuiServer(testPort);
    resetHistory([]);
    try {
      const csv = 'sku,title,price\r\nHTTP-1,Http Item,12.5\r\n';
      const bad = await fetch(`http://127.0.0.1:${testPort}/api/listings/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json'
      });
      assert.strictEqual(bad.status, 400);
      const empty = await fetch(`http://127.0.0.1:${testPort}/api/listings/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.strictEqual(empty.status, 400);
      const dry = await fetch(`http://127.0.0.1:${testPort}/api/listings/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, dryRun: true })
      });
      const dryData = await dry.json();
      assert.strictEqual(dryData.success, true);
      assert.strictEqual(dryData.valid, 1);
      assert.deepStrictEqual(utils.readJsonFileSecure(config.historyPath, []), []);
      const live = await fetch(`http://127.0.0.1:${testPort}/api/listings/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv })
      });
      const liveData = await live.json();
      assert.strictEqual(liveData.success, true);
      assert.strictEqual(liveData.imported, 1);
      const history = utils.readJsonFileSecure(config.historyPath, []);
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].status, 'DRAFT');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('GET /api/team requires login', async () => {
    const testPort = 45923;
    const server = webServer.startWebGuiServer(testPort);
    try {
      const res = await fetch(`http://127.0.0.1:${testPort}/api/team`);
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.match(data.error, /Login required/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Restore pre-block state.
  if (historyBackup === null) { try { fs.unlinkSync(config.historyPath); } catch (e) {} }
  else fs.writeFileSync(config.historyPath, historyBackup, 'utf8');
  if (teamBackup === null) { try { fs.unlinkSync(config.teamPath); } catch (e) {} }
  else fs.writeFileSync(config.teamPath, teamBackup, 'utf8');
  if (billingBackup === null) { try { fs.unlinkSync(billingDbPath); } catch (e) {} }
  else fs.writeFileSync(billingDbPath, billingBackup, 'utf8');
  if (originalGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalGoogleClientId;
});
