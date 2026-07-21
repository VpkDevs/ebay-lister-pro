const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('./logger');

const dbPath = path.join(process.cwd(), 'data', 'lister.db');
const db = new Database(dbPath);

// Enable WAL mode for high performance concurrency
db.pragma('journal_mode = WAL');

// Migrations system
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );
`);

const migrations = [
  // Version 1
  `
  CREATE TABLE IF NOT EXISTS listings (
    sku TEXT PRIMARY KEY,
    timestamp TEXT,
    listingId TEXT,
    title TEXT,
    price REAL,
    categoryId TEXT,
    offerId TEXT,
    shopifyId TEXT,
    woocommerceId TEXT,
    etsyId TEXT,
    status TEXT,
    brand TEXT,
    veroWarning INTEGER DEFAULT 0,
    priceFloor REAL,
    priceCap REAL,
    priceLocked INTEGER DEFAULT 0,
    listingDetails TEXT
  );
  
  CREATE TABLE IF NOT EXISTS templates (
    name TEXT PRIMARY KEY,
    data TEXT
  );
  
  CREATE TABLE IF NOT EXISTS dlq (
    id TEXT PRIMARY KEY,
    timestamp TEXT,
    platform TEXT,
    sku TEXT,
    listing TEXT,
    imageUrls TEXT,
    attempts INTEGER DEFAULT 0,
    lastError TEXT,
    exhausted INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS billing (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `
];

let currentVersion = 0;
const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
if (versionRow) {
  currentVersion = versionRow.version;
} else {
  db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
}

for (let i = currentVersion; i < migrations.length; i++) {
  const version = i + 1;
  logger.info(`Running database migration to version ${version}...`);
  db.transaction(() => {
    db.exec(migrations[i]);
    db.prepare('UPDATE schema_version SET version = ?').run(version);
  })();
}

function mapRowToListing(row) {
  return {
    ...row,
    price: parseFloat(row.price),
    veroWarning: !!row.veroWarning,
    priceLocked: !!row.priceLocked,
    listingDetails: row.listingDetails ? JSON.parse(row.listingDetails) : null
  };
}

function mapRowToDlq(row) {
  return {
    ...row,
    listing: JSON.parse(row.listing),
    imageUrls: JSON.parse(row.imageUrls),
    exhausted: !!row.exhausted
  };
}

const listingsRepo = {
  findAll() {
    const rows = db.prepare('SELECT * FROM listings ORDER BY timestamp DESC').all();
    return rows.map(mapRowToListing);
  },
  findBySku(sku) {
    const row = db.prepare('SELECT * FROM listings WHERE sku = ?').get(sku);
    return row ? mapRowToListing(row) : null;
  },
  save(entry) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO listings (
        sku, timestamp, listingId, title, price, categoryId, offerId,
        shopifyId, woocommerceId, etsyId, status, brand, veroWarning,
        priceFloor, priceCap, priceLocked, listingDetails
      ) VALUES (
        @sku, @timestamp, @listingId, @title, @price, @categoryId, @offerId,
        @shopifyId, @woocommerceId, @etsyId, @status, @brand, @veroWarning,
        @priceFloor, @priceCap, @priceLocked, @listingDetails
      )
    `);
    return insert.run({
      sku: entry.sku,
      timestamp: entry.timestamp || new Date().toISOString(),
      listingId: entry.listingId || null,
      title: entry.title || null,
      price: entry.price !== undefined ? parseFloat(entry.price) : 0,
      categoryId: entry.categoryId || null,
      offerId: entry.offerId || null,
      shopifyId: entry.shopifyId || null,
      woocommerceId: entry.woocommerceId || null,
      etsyId: entry.etsyId || null,
      status: entry.status || 'ACTIVE',
      brand: entry.brand || 'Generic',
      veroWarning: entry.veroWarning ? 1 : 0,
      priceFloor: entry.priceFloor !== undefined ? entry.priceFloor : null,
      priceCap: entry.priceCap !== undefined ? entry.priceCap : null,
      priceLocked: entry.priceLocked ? 1 : 0,
      listingDetails: entry.listingDetails ? JSON.stringify(entry.listingDetails) : null
    });
  },
  delete(sku) {
    return db.prepare('DELETE FROM listings WHERE sku = ?').run(sku).changes > 0;
  },
  clear() {
    return db.prepare('DELETE FROM listings').run().changes;
  }
};

const templatesRepo = {
  findAll() {
    const rows = db.prepare('SELECT * FROM templates').all();
    return rows.map(r => JSON.parse(r.data));
  },
  save(template) {
    const insert = db.prepare('INSERT OR REPLACE INTO templates (name, data) VALUES (?, ?)');
    return insert.run(template.name, JSON.stringify(template));
  },
  delete(name) {
    return db.prepare('DELETE FROM templates WHERE name = ?').run(name).changes > 0;
  },
  clear() {
    return db.prepare('DELETE FROM templates').run().changes;
  }
};

const dlqRepo = {
  findAll() {
    const rows = db.prepare('SELECT * FROM dlq').all();
    return rows.map(mapRowToDlq);
  },
  save(entry) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO dlq (
        id, timestamp, platform, sku, listing, imageUrls, attempts, lastError, exhausted
      ) VALUES (
        @id, @timestamp, @platform, @sku, @listing, @imageUrls, @attempts, @lastError, @exhausted
      )
    `);
    return insert.run({
      id: entry.id,
      timestamp: entry.timestamp || new Date().toISOString(),
      platform: entry.platform,
      sku: entry.sku,
      listing: JSON.stringify(entry.listing),
      imageUrls: JSON.stringify(entry.imageUrls || []),
      attempts: entry.attempts || 0,
      lastError: entry.lastError || null,
      exhausted: entry.exhausted ? 1 : 0
    });
  },
  delete(sku, platform) {
    return db.prepare('DELETE FROM dlq WHERE sku = ? AND platform = ?').run(sku, platform).changes > 0;
  },
  clear() {
    return db.prepare('DELETE FROM dlq').run().changes;
  }
};

const billingRepo = {
  get() {
    const row = db.prepare('SELECT value FROM billing WHERE key = ?').get('history');
    return row ? JSON.parse(row.value) : {};
  },
  save(data) {
    const insert = db.prepare('INSERT OR REPLACE INTO billing (key, value) VALUES (?, ?)');
    return insert.run('history', JSON.stringify(data));
  }
};

// AUTO-MIGRATION OF LEGACY JSON FILES
// 1. Listings
const historyFile = config.historyPath;
if (fs.existsSync(historyFile)) {
  try {
    const raw = fs.readFileSync(historyFile, 'utf8');
    const items = JSON.parse(raw);
    if (Array.isArray(items)) {
      logger.info(`Migrating ${items.length} listing history items to SQLite...`);
      for (const item of items) {
        listingsRepo.save(item);
      }
    }
    fs.renameSync(historyFile, `${historyFile}.bak`);
  } catch (e) {
    logger.error({ err: e }, "Failed to migrate listings-history.json to SQLite");
  }
}

// 2. DLQ
const dlqFile = config.dlqPath;
if (fs.existsSync(dlqFile)) {
  try {
    const raw = fs.readFileSync(dlqFile, 'utf8');
    const items = JSON.parse(raw);
    if (Array.isArray(items)) {
      logger.info(`Migrating ${items.length} DLQ items to SQLite...`);
      for (const item of items) {
        dlqRepo.save(item);
      }
    }
    fs.renameSync(dlqFile, `${dlqFile}.bak`);
  } catch (e) {
    logger.error({ err: e }, "Failed to migrate pending-syncs.json to SQLite");
  }
}

// 3. Templates
const templatesFile = path.join(process.cwd(), 'data', 'templates.json');
if (fs.existsSync(templatesFile)) {
  try {
    const raw = fs.readFileSync(templatesFile, 'utf8');
    const items = JSON.parse(raw);
    if (Array.isArray(items)) {
      logger.info(`Migrating ${items.length} templates to SQLite...`);
      for (const item of items) {
        templatesRepo.save(item);
      }
    }
    fs.renameSync(templatesFile, `${templatesFile}.bak`);
  } catch (e) {
    logger.error({ err: e }, "Failed to migrate templates.json to SQLite");
  }
}

// 4. Billing status
const billingFile = path.join(process.cwd(), 'scratch', 'billing_status.json');
if (fs.existsSync(billingFile)) {
  try {
    const raw = fs.readFileSync(billingFile, 'utf8');
    const data = JSON.parse(raw);
    logger.info("Migrating billing status to SQLite...");
    billingRepo.save(data);
    fs.renameSync(billingFile, `${billingFile}.bak`);
  } catch (e) {
    logger.error({ err: e }, "Failed to migrate billing_status.json to SQLite");
  }
}

module.exports = {
  db,
  listings: listingsRepo,
  templates: templatesRepo,
  dlq: dlqRepo,
  billing: billingRepo
};
