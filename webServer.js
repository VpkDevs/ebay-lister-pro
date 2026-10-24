/**
 * @file webServer.js
 * @description Serves the HTML dashboard and exposes JSON endpoints for listing synchronization, analysis, and posting.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const config = require('./config');
const utils = require('./utils');
const ebayClient = require('./ebayClient');
const geminiClient = require('./geminiClient');

function sendError(res, err, status = 500) {
  if (res.headersSent || res.writableEnded) return;
  const statusCode = err.status || err.statusCode || status;
  const errorCode = err.code || "INTERNAL_SERVER_ERROR";
  const responseBody = {
    error: errorCode,
    message: utils.sanitizeLog(err.message || String(err))
  };
  if (err.details) {
    responseBody.details = err.details;
  }
  if (err.ebayErrorCode) {
    responseBody.ebayErrorCode = err.ebayErrorCode;
  }
  if (err.ebayTraceId) {
    responseBody.ebayTraceId = err.ebayTraceId;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responseBody));
}

let shutdownRegistered = false;
let shopifyLocationId = null;

async function runInventoryCrossSync() {
  const shopName = config.getSHOPIFY_SHOP_NAME();
  const accessToken = config.getSHOPIFY_ACCESS_TOKEN();
  const ebayToken = ebayClient.getAccessToken();

  if (!ebayToken) {
    return;
  }

  const history = await utils.readJsonFileSecureAsync(config.historyPath, []);
  let historyChanged = false;

  const activeItems = history.filter(item => item.status === "ACTIVE");
  if (activeItems.length === 0) return;

  utils.logAudit("INFO", `Starting background inventory cross-sync for ${activeItems.length} active listings...`);

  const CHUNK_SIZE = 5;
  for (let i = 0; i < activeItems.length; i += CHUNK_SIZE) {
    const chunk = activeItems.slice(i, i + CHUNK_SIZE);
    
    await Promise.all(chunk.map(async (item) => {
      let itemChanged = false;
      
      // 1. Shopify to eBay Sync
      if (item.shopifyId && shopName && accessToken) {
        try {
          const url = `https://${shopName}.myshopify.com/admin/api/2024-01/products/${item.shopifyId}.json`;
          const response = await ebayClient.fetchWithRetry(url, {
            headers: {
              "X-Shopify-Access-Token": accessToken,
              "Accept": "application/json"
            }
          });

          if (response.status === 404) {
            utils.logAudit("INFO", `Shopify product ${item.shopifyId} not found (deleted). Ending eBay SKU ${item.sku}...`);
            try {
              await ebayClient.endListingOnEbay(item.sku, item.offerId);
              item.status = "ENDED";
              itemChanged = true;
            } catch (e) {
              utils.logAudit("ERROR", `Failed to end eBay listing for SKU ${item.sku}: ${e.message}`);
            }
          } else if (response.ok) {
            const shopifyProd = await response.json();
            const product = shopifyProd.product;
            
            if (product) {
              const isInactive = product.status !== "active";
              const totalInventory = (product.variants || []).reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
              
              if (isInactive || totalInventory === 0) {
                utils.logAudit("INFO", `Shopify product ${item.shopifyId} is inactive or out of stock. Ending eBay SKU ${item.sku}...`);
                try {
                  await ebayClient.endListingOnEbay(item.sku, item.offerId);
                  item.status = "ENDED";
                  itemChanged = true;
                } catch (e) {
                  utils.logAudit("ERROR", `Failed to end eBay listing for SKU ${item.sku}: ${e.message}`);
                }
              }
            }
          }
        } catch (err) {
          utils.logAudit("WARN", `Error querying Shopify status for SKU ${item.sku}: ${err.message}`);
        }
      }

      // 2. eBay to Shopify Sync
      if (item.listingId && item.status !== "ENDED") {
        try {
          const offerRes = await ebayClient.ebayRequest(`/offer?sku=${encodeURIComponent(item.sku)}`, "GET");
          const offers = offerRes.offers || [];
          const activeOffer = offers.find(o => o.sku === item.sku && o.status === "LISTED");

          if (!activeOffer) {
            utils.logAudit("INFO", `eBay SKU ${item.sku} is no longer active/listed on eBay. Reflecting to Shopify product ${item.shopifyId}...`);
            item.status = "ENDED";
            itemChanged = true;

            if (item.shopifyId && shopName && accessToken) {
              try {
                const url = `https://${shopName}.myshopify.com/admin/api/2024-01/products/${item.shopifyId}.json`;
                await ebayClient.fetchWithRetry(url, {
                  method: "PUT",
                  headers: {
                    "X-Shopify-Access-Token": accessToken,
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({
                    product: {
                      id: item.shopifyId,
                      status: "archived"
                    }
                  })
                });
                utils.logAudit("INFO", `Shopify product ${item.shopifyId} set to archived.`);
              } catch (err) {
                utils.logAudit("WARN", `Failed to archive Shopify product ${item.shopifyId}: ${err.message}`);
              }
            }
          }
        } catch (err) {
          utils.logAudit("WARN", `Error querying eBay status for SKU ${item.sku}: ${err.message}`);
        }
      }

      if (itemChanged) {
        historyChanged = true;
      }
    }));
  }

  if (historyChanged) {
    await utils.writeJsonFileSecureAsync(config.historyPath, history);
  }
}

const crypto = require('crypto');

// [WAVE1-B] Allowed statuses for bulk updates (subset of statuses used in history).
const BULK_ALLOWED_STATUSES = ["ACTIVE", "DRAFT", "ENDED", "SOLD"];

/**
 * [WAVE1-B] Escapes a single value for CSV output (RFC 4180).
 * Wraps in double quotes when the value contains a comma, quote, or newline,
 * and doubles any embedded quotes.
 * @param {*} value - Raw cell value.
 * @returns {string} CSV-safe cell text.
 */
function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * [WAVE1-D] Canonical CSV column order. Export and import share this list so
 * a downloaded export can be edited and re-imported (round-trip safe).
 * Import treats sku/title/price as required input; status/createdAt/marketplace
 * IDs are export-only output columns and are ignored on import (imports always
 * create DRAFT listings).
 */
const LISTING_CSV_HEADERS = [
  "sku", "title", "price", "msrp", "keywords", "costOfGoods", "internalNotes",
  "status", "categoryId", "createdAt",
  "ebayListingId", "shopifyId", "woocommerceId", "etsyId"
];

/**
 * [WAVE1-B] Builds the full CSV export of listings history.
 * Includes Wave-1 fields (keywords, msrp, costOfGoods, internalNotes) when present;
 * fields added by other waves are read defensively and export as empty columns
 * when absent. Export is local-only, so internalNotes are safe to include.
 * @param {Array<object>} history - Listings history rows.
 * @returns {string} CSV document text.
 */
function buildListingsCsv(history) {
  const headers = LISTING_CSV_HEADERS;
  const lines = [headers.join(",")];
  for (const item of history) {
    const details = item.listingDetails || {};
    // Wave-1 fields may live top-level (A-wave) or inside listingDetails; check both.
    const keywords = item.keywords ?? details.keywords ?? "";
    const msrp = item.msrp ?? details.msrp ?? "";
    const costOfGoods = item.costOfGoods ?? details.costOfGoods ?? "";
    const internalNotes = item.internalNotes ?? details.internalNotes ?? "";
    const row = [
      item.sku,
      item.title,
      item.price,
      msrp,
      Array.isArray(keywords) ? keywords.join("; ") : keywords,
      costOfGoods,
      internalNotes,
      item.status || "ACTIVE",
      item.categoryId,
      item.timestamp,
      item.listingId,
      item.shopifyId,
      item.woocommerceId,
      item.etsyId
    ];
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * [WAVE1-D] Parses CSV text (RFC 4180) into rows of cell strings.
 * Handles quoted fields containing commas, quotes (""), and newlines, plus
 * CRLF/LF line endings, a leading BOM, and blank lines.
 * @param {string} text - Raw CSV document text.
 * @returns {string[][]} Rows of cells (first row = header).
 * @throws {Error} On an unterminated quoted field.
 */
function parseListingsCsv(text) {
  const src = String(text).replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = "";
    } else if (ch === '\r') {
      if (src[i + 1] !== '\n') { row.push(field); field = ""; rows.push(row); row = []; }
      // else: CRLF — the \n branch below ends the row
    } else if (ch === '\n') {
      row.push(field); field = ""; rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new Error("Malformed CSV: unterminated quoted field.");
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  // Drop blank lines (a single empty cell).
  return rows.filter(r => !(r.length === 1 && r[0] === ""));
}

/**
 * [WAVE1-D] Validates one imported CSV row against the listing schema.
 * @param {string[]} cells - Raw cell values for the row.
 * @param {Object<string,number>} headerIndex - Header name -> column index.
 * @param {Set<string>} seenSkus - SKUs already seen in this file.
 * @param {Set<string>} historySkus - SKUs already in history.
 * @returns {{ok:boolean, sku:string, errors:string[], listing:object|null}}
 */
function validateImportRow(cells, headerIndex, seenSkus, historySkus) {
  const get = (name) => {
    const idx = headerIndex[name];
    return idx === undefined ? "" : String(cells[idx] ?? "").trim();
  };
  const errors = [];
  const sku = get("sku");
  if (!sku) errors.push('sku is required');
  else if (seenSkus.has(sku)) errors.push(`duplicate sku "${sku}" in this file`);
  else if (historySkus.has(sku)) errors.push(`sku "${sku}" already exists`);
  const title = get("title");
  if (!title) errors.push("title is required");
  const priceRaw = get("price");
  const price = Number(priceRaw);
  if (priceRaw === "" || isNaN(price) || price < 0) {
    errors.push(`price must be a number >= 0 (got "${priceRaw}")`);
  }
  for (const key of ["msrp", "costOfGoods"]) {
    const raw = get(key);
    if (raw !== "" && (isNaN(Number(raw)) || Number(raw) < 0)) {
      errors.push(`${key} must be a number >= 0 (got "${raw}")`);
    }
  }
  if (errors.length > 0) return { ok: false, sku, errors, listing: null };
  // Keywords: export joins with "; " — split on ";" for an exact round-trip.
  const keywordsRaw = get("keywords");
  const keywords = keywordsRaw === "" ? []
    : keywordsRaw.split(";").map(k => k.trim()).filter(k => k.length > 0);
  return {
    ok: true,
    sku,
    errors: [],
    listing: {
      title,
      price,
      msrp: get("msrp") === "" ? null : Number(get("msrp")),
      costOfGoods: get("costOfGoods") === "" ? null : Number(get("costOfGoods")),
      keywords,
      internalNotes: get("internalNotes"),
      categoryId: get("categoryId") || null
    }
  };
}

/**
 * [WAVE1-D] Imports inventory rows from CSV text as DRAFT listings.
 * Mirrors the export schema so exports round-trip. Each valid row goes through
 * the same history write path as /api/save-draft (with Wave-1A field
 * normalization); drafts are flagged _confidence: 0 so the Wave-1C uncertainty
 * UI marks them for human review (they were not AI-generated).
 * @param {string} csvText - Raw CSV document text.
 * @param {{dryRun?:boolean}} [opts] - When dryRun is true, validate only.
 * @returns {{imported:number, valid:number, failed:number, total:number, results:Array}}
 * @throws {Error} On empty input or missing required columns.
 */
function importListingsFromCsv(csvText, opts = {}) {
  const dryRun = !!opts.dryRun;
  const rows = parseListingsCsv(csvText);
  if (rows.length === 0) throw new Error("CSV is empty.");
  const headers = rows[0].map(h => String(h).trim());
  const headerIndex = {};
  headers.forEach((h, i) => { if (!(h in headerIndex)) headerIndex[h] = i; });
  for (const required of ["sku", "title", "price"]) {
    if (!(required in headerIndex)) throw new Error(`Missing required column "${required}".`);
  }
  const history = utils.readJsonFileSecure(config.historyPath, []);
  const historySkus = new Set(history.map(h => h.sku));
  const seenSkus = new Set();
  const results = [];
  let imported = 0;
  let valid = 0;
  for (let r = 1; r < rows.length; r++) {
    const lineNo = r + 1;
    const v = validateImportRow(rows[r], headerIndex, seenSkus, historySkus);
    if (!v.ok) {
      results.push({ row: lineNo, sku: v.sku || null, ok: false, error: v.errors.join("; ") });
      continue;
    }
    seenSkus.add(v.sku);
    valid++;
    if (!dryRun) {
      const details = utils.normalizeListingFields({
        title: v.listing.title,
        suggestedPrice: v.listing.price,
        categoryId: v.listing.categoryId,
        keywords: v.listing.keywords,
        msrp: v.listing.msrp,
        costOfGoods: v.listing.costOfGoods,
        internalNotes: v.listing.internalNotes,
        _confidence: 0,          // not AI-generated -> Wave-1C review badge
        importSource: "csv"
      });
      utils.saveListingToHistory(
        v.sku, null, v.listing.title, v.listing.price, v.listing.categoryId,
        null, null, "DRAFT", details
      );
      imported++;
    }
    results.push({ row: lineNo, sku: v.sku, ok: true, error: null });
  }
  if (!dryRun && imported > 0) {
    utils.logAudit("INFO", `CSV import: ${imported} draft(s) created, ${results.length - imported} row(s) rejected.`);
  }
  return {
    imported,
    valid,
    failed: results.filter(x => !x.ok).length,
    total: results.length,
    results
  };
}

/**
 * [WAVE1-B] Bulk-updates listing statuses through the same read/mutate/write path
 * as the inventory cross-sync (no parallel store). Reports per-SKU success/failure.
 * @param {string[]} skus - SKUs to update.
 * @param {string} status - New status (one of BULK_ALLOWED_STATUSES).
 * @returns {{updated:number, results:Array<{sku:string,ok:boolean,error:string|null}>}}
 * @throws {Error} When status is invalid.
 */
function bulkUpdateListingStatus(skus, status) {
  if (!BULK_ALLOWED_STATUSES.includes(status)) {
    throw new Error(`Invalid status "${status}". Allowed: ${BULK_ALLOWED_STATUSES.join(", ")}`);
  }
  const history = utils.readJsonFileSecure(config.historyPath, []);
  const results = [];
  let updated = 0;
  for (const sku of skus) {
    try {
      const item = history.find(i => i.sku === sku);
      if (!item) {
        results.push({ sku, ok: false, error: "SKU not found" });
        continue;
      }
      item.status = status;
      updated++;
      results.push({ sku, ok: true, error: null });
    } catch (err) {
      results.push({ sku, ok: false, error: err.message });
    }
  }
  if (updated > 0) {
    utils.writeJsonFileSecure(config.historyPath, history);
  }
  utils.logAudit("INFO", `Bulk status update to "${status}": ${updated}/${skus.length} updated.`);
  return { updated, results };
}

/* ==========================================================================
 * [WAVE1-D] Team seats (Power Seller workspaces).
 *
 * Minimal honest model: the subscription owner holds the workspace; the app's
 * single-tenant data store is shared by every seat, so "shared workspace" is
 * structural (all seats see the same listings) rather than a sync layer.
 * Roles are owner/member only — no permissions matrix. Invites are pending
 * until the invitee logs in and accepts (no email delivery exists in this
 * codebase); pending invites hold a seat so a workspace cannot over-invite.
 * Seats go dormant (member workspace lookups return null) if the owner's
 * Power Seller subscription lapses.
 * ========================================================================== */

// [WAVE1-D] Seats granted per billing plan. Plans not listed here get no team features.
const TEAM_SEATS_BY_PLAN = { power_seller: 3 };

/**
 * [WAVE1-D] Seats available for a billing plan (0 when the plan has no team features).
 * @param {string} plan - Billing plan id.
 * @returns {number}
 */
function getTeamMaxSeats(plan) {
  return TEAM_SEATS_BY_PLAN[plan] || 0;
}

/**
 * [WAVE1-D] Resolves the caller's billing standing from the local billing store
 * (written by the Stripe webhook). Unknown/absent records are treated as the
 * free Starter tier — never as premium.
 * @param {string} email - Account email.
 * @returns {{premium:boolean, plan:string}}
 */
function getBillingPlan(email) {
  const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
  const billingHistory = utils.readJsonFileSecure(billingDbPath, {});
  const rec = email ? billingHistory[email] : null;
  if (!rec || !rec.premium) return { premium: false, plan: "starter" };
  return { premium: true, plan: rec.plan || "pro" };
}

/**
 * [WAVE1-D] Reads the team store: { [ownerEmail]: { members: [{email,status,addedAt}] } }.
 * @returns {object}
 */
function readTeamStore() {
  return utils.readJsonFileSecure(config.teamPath, {});
}

/**
 * [WAVE1-D] Persists the team store.
 * @param {object} store - Team store object.
 */
function writeTeamStore(store) {
  utils.writeJsonFileSecure(config.teamPath, store);
}

/**
 * [WAVE1-D] Seats currently held (active + pending invites) in a team record.
 * @param {{members:Array}} record - Team record.
 * @returns {number}
 */
function countUsedSeats(record) {
  return (record.members || []).filter(m => m.status === "active" || m.status === "invited").length;
}

/**
 * [WAVE1-D] Invites an email to the owner's workspace as a pending member.
 * Requires the owner to hold an active Power Seller subscription.
 * @param {string} ownerEmail - Workspace owner.
 * @param {string} memberEmail - Invitee email.
 * @returns {{email:string,status:string,addedAt:string}} The invite record.
 * @throws {Error} When validation fails.
 */
function inviteTeamMember(ownerEmail, memberEmail) {
  memberEmail = String(memberEmail || "").trim().toLowerCase();
  if (!memberEmail || !memberEmail.includes("@")) {
    throw new Error("A valid member email is required.");
  }
  if (memberEmail === String(ownerEmail).toLowerCase()) {
    throw new Error("You cannot invite yourself.");
  }
  const { premium, plan } = getBillingPlan(ownerEmail);
  if (!premium || plan !== "power_seller") {
    throw new Error("Team seats require an active Power Seller subscription.");
  }
  const store = readTeamStore();
  const record = store[ownerEmail] || { members: [] };
  if (record.members.some(m => m.email === memberEmail)) {
    throw new Error(`${memberEmail} is already on the team.`);
  }
  if (countUsedSeats(record) >= getTeamMaxSeats(plan)) {
    throw new Error(`Seat limit reached (${getTeamMaxSeats(plan)} seats on Power Seller).`);
  }
  const invite = { email: memberEmail, status: "invited", addedAt: new Date().toISOString() };
  record.members.push(invite);
  store[ownerEmail] = record;
  writeTeamStore(store);
  utils.logAudit("INFO", `Team invite: ${ownerEmail} invited ${memberEmail}.`);
  return invite;
}

/**
 * [WAVE1-D] Removes a member (active or invited) from the workspace. Owner-only.
 * @param {string} ownerEmail - Workspace owner.
 * @param {string} memberEmail - Member email to remove.
 * @returns {boolean} True when a member was removed.
 * @throws {Error} When the member is not on the team.
 */
function removeTeamMember(ownerEmail, memberEmail) {
  memberEmail = String(memberEmail || "").trim().toLowerCase();
  const store = readTeamStore();
  const record = store[ownerEmail];
  if (!record || !record.members.some(m => m.email === memberEmail)) {
    throw new Error(`${memberEmail} is not on the team.`);
  }
  record.members = record.members.filter(m => m.email !== memberEmail);
  store[ownerEmail] = record;
  writeTeamStore(store);
  utils.logAudit("INFO", `Team remove: ${ownerEmail} removed ${memberEmail}.`);
  return true;
}

/**
 * [WAVE1-D] Accepts a pending invite. The invitee must be logged in as the
 * invited email; the owner's subscription is re-checked at accept time.
 * @param {string} ownerEmail - Workspace owner.
 * @param {string} memberEmail - Invitee email (must match the logged-in user).
 * @returns {{email:string,status:string,addedAt:string}} The activated member record.
 * @throws {Error} When no pending invite exists or the owner's plan lapsed.
 */
function acceptTeamInvite(ownerEmail, memberEmail) {
  memberEmail = String(memberEmail || "").trim().toLowerCase();
  const { premium, plan } = getBillingPlan(ownerEmail);
  if (!premium || plan !== "power_seller") {
    throw new Error("This workspace's Power Seller subscription is no longer active.");
  }
  const store = readTeamStore();
  const record = store[ownerEmail];
  const invite = record && record.members.find(m => m.email === memberEmail && m.status === "invited");
  if (!invite) {
    throw new Error("No pending invite found for this workspace.");
  }
  invite.status = "active";
  writeTeamStore(store);
  utils.logAudit("INFO", `Team accept: ${memberEmail} joined ${ownerEmail}'s workspace.`);
  return invite;
}

/**
 * [WAVE1-D] Lets an active member leave their workspace.
 * @param {string} memberEmail - Member email leaving.
 * @returns {string|null} The owner email left, or null when not on a team.
 */
function leaveTeam(memberEmail) {
  memberEmail = String(memberEmail || "").trim().toLowerCase();
  const store = readTeamStore();
  for (const [ownerEmail, record] of Object.entries(store)) {
    const idx = (record.members || []).findIndex(m => m.email === memberEmail && m.status === "active");
    if (idx !== -1) {
      record.members.splice(idx, 1);
      store[ownerEmail] = record;
      writeTeamStore(store);
      utils.logAudit("INFO", `Team leave: ${memberEmail} left ${ownerEmail}'s workspace.`);
      return ownerEmail;
    }
  }
  return null;
}

/**
 * [WAVE1-D] Resolves which workspace (if any) an email belongs to.
 * Owners qualify only while their Power Seller subscription is active; members
 * qualify only while their seat is active AND the owner's subscription is active.
 * @param {string} email - Account email.
 * @returns {{role:"owner"|"member", owner:string}|null}
 */
function getWorkspaceFor(email) {
  email = String(email || "").trim().toLowerCase();
  if (!email) return null;
  const self = getBillingPlan(email);
  if (self.premium && self.plan === "power_seller") {
    return { role: "owner", owner: email };
  }
  const store = readTeamStore();
  for (const [ownerEmail, record] of Object.entries(store)) {
    const member = (record.members || []).find(m => m.email === email && m.status === "active");
    if (member) {
      const ownerBilling = getBillingPlan(ownerEmail);
      if (ownerBilling.premium && ownerBilling.plan === "power_seller") {
        return { role: "member", owner: ownerEmail };
      }
      return null; // owner's subscription lapsed -> seat dormant
    }
  }
  return null;
}
const activeSessions = new Map();

// Metrics tracking structure
const metrics = {
  totalRequests: 0,
  endpointCounts: {},
  endpointErrors: {},
  latencyData: new Map(),
  outboundCalls: {
    total: 0,
    failures: 0
  }
};

// Zero-dependency token bucket rate limiter
const rateLimits = new Map();
const RATE_LIMIT_CAPACITY = 60;
const RATE_LIMIT_REFILL_RATE = 1; // 1 token per second

const analyzeRateLimits = new Map();
const ANALYZE_LIMIT_CAPACITY = 5;
const ANALYZE_REFILL_RATE = 5 / 60; // 5 tokens per 60 seconds

function checkRateLimit(ip, path) {
  const isAnalyze = path === '/api/analyze';
  const limitsMap = isAnalyze ? analyzeRateLimits : rateLimits;
  const capacity = isAnalyze ? ANALYZE_LIMIT_CAPACITY : RATE_LIMIT_CAPACITY;
  const refillRate = isAnalyze ? ANALYZE_REFILL_RATE : RATE_LIMIT_REFILL_RATE;
  
  const now = Date.now();
  if (!limitsMap.has(ip)) {
    limitsMap.set(ip, { tokens: capacity - 1, lastRefill: now });
    return true;
  }
  
  const client = limitsMap.get(ip);
  const elapsedSeconds = (now - client.lastRefill) / 1000;
  client.tokens = Math.min(capacity, client.tokens + elapsedSeconds * refillRate);
  client.lastRefill = now;
  
  if (client.tokens >= 1) {
    client.tokens -= 1;
    return true;
  }
  return false;
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:';
  } catch (e) {
    return false;
  }
}

/**
 * Helper to parse HTTP cookies.
 * @param {string} cookieHeader 
 * @returns {object}
 */
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

/**
 * Gets authenticated user session or validates API Key header.
 * @param {http.IncomingMessage} req 
 * @returns {object|null}
 */
function getAuthenticatedUser(req) {
  // Check Chrome Extension API Key header
  const apiKey = req.headers['x-lister-api-key'] || (new URL(req.url, 'http://localhost')).searchParams.get('apiKey');
  if (apiKey === config.getAPI_KEY()) {
    return { email: "extension@local.lister", role: "API_USER", isPremium: true };
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.sessionId;
  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    if (Date.now() < session.expiresAt) {
      return session.user;
    } else {
      activeSessions.delete(sessionId);
    }
  }
  return null;
}

/* ============================================================================
 * [WAVE1-C] Extended barcode enrichment.
 * Resolution order per barcode:
 *   1. ISBN-13 (978/979 prefix) -> Google Books (keyless public API).
 *   2. Everything else -> existing eBay catalog path (unchanged behavior).
 *   3. On an eBay catalog miss for a non-ISBN code -> music sources:
 *      Discogs barcode search if DISCOGS_TOKEN is set, else MusicBrainz.
 * Every step degrades gracefully; null just means "no catalog data".
 * ========================================================================== */

/**
 * Detects an ISBN-13 barcode (13 digits starting with 978 or 979).
 * @param {string} code - Cleaned barcode digits.
 * @returns {boolean}
 */
function isIsbn13(code) {
  const digits = String(code || '').replace(/[\s-]/g, '');
  return /^\d{13}$/.test(digits) && (digits.startsWith('978') || digits.startsWith('979'));
}

/**
 * Looks up an ISBN on Google Books (no API key needed) and maps
 * title/authors/publisher/publishedDate/pageCount into the upcData shape.
 * @param {string} isbn - 13-digit ISBN.
 * @returns {Promise<object|null>} upcData-compatible object or null.
 */
async function lookupIsbnOnGoogleBooks(isbn) {
  try {
    const response = await ebayClient.fetchWithRetry(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`,
      { headers: { "Accept": "application/json" } },
      2, 500
    );
    if (!response.ok) return null;
    const data = await response.json();
    const info = data.items?.[0]?.volumeInfo;
    if (!info || !info.title) return null;

    const authors = Array.isArray(info.authors) ? info.authors : [];
    const thumbnail = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || null;
    const aspects = {};
    if (authors.length > 0) aspects['Author'] = authors.join(', ');
    if (info.publisher) aspects['Publisher'] = info.publisher;
    if (info.publishedDate) aspects['Published Date'] = info.publishedDate;
    if (info.pageCount) aspects['Page Count'] = String(info.pageCount);

    utils.logAudit("INFO", `Google Books ISBN lookup successful: ${info.title}`);
    return {
      title: info.title,
      brand: info.publisher || 'Unknown',
      mpn: isbn,
      stockImageUrls: thumbnail ? [thumbnail] : [],
      aspects,
      source: 'google-books',
      authors,
      publisher: info.publisher || null,
      publishedDate: info.publishedDate || null,
      pageCount: info.pageCount || null
    };
  } catch (err) {
    utils.logAudit("WARN", `Google Books ISBN lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Looks up a music barcode (CD/vinyl) on Discogs.
 * HARD BLOCKER NOTE: the Discogs search API is auth-only — without a
 * DISCOGS_TOKEN env var there is no anonymous search, so this path is skipped
 * entirely and MusicBrainz is used instead.
 * @param {string} code - Cleaned barcode digits.
 * @param {string} token - Discogs personal access token.
 * @returns {Promise<object|null>} upcData-compatible object or null.
 */
async function lookupBarcodeOnDiscogs(code, token) {
  try {
    const response = await ebayClient.fetchWithRetry(
      `https://api.discogs.com/database/search?barcode=${encodeURIComponent(code)}`,
      {
        headers: {
          "Accept": "application/json",
          "Authorization": `Discogs token=${token}`,
          "User-Agent": "ebay-lister-pro/1.0"
        }
      },
      2, 500
    );
    if (!response.ok) return null;
    const data = await response.json();
    const hit = data.results?.[0];
    if (!hit || !hit.title) return null;

    const aspects = {};
    if (hit.year) aspects['Year'] = String(hit.year);
    if (hit.label?.[0]) aspects['Label'] = hit.label[0];
    if (hit.genre?.[0]) aspects['Genre'] = hit.genre[0];
    if (hit.format?.[0]) aspects['Format'] = hit.format[0];

    utils.logAudit("INFO", `Discogs barcode lookup successful: ${hit.title}`);
    return {
      title: hit.title,
      brand: hit.label?.[0] || 'Unknown',
      mpn: code,
      stockImageUrls: hit.cover_image ? [hit.cover_image] : [],
      aspects,
      source: 'discogs'
    };
  } catch (err) {
    utils.logAudit("WARN", `Discogs barcode lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Looks up a music barcode on MusicBrainz (keyless; requires a User-Agent).
 * @param {string} code - Cleaned barcode digits.
 * @returns {Promise<object|null>} upcData-compatible object or null.
 */
async function lookupBarcodeOnMusicBrainz(code) {
  try {
    const response = await ebayClient.fetchWithRetry(
      `https://musicbrainz.org/ws/2/release/?query=barcode:${encodeURIComponent(code)}&fmt=json`,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "ebay-lister-pro/1.0 (barcode lookup)"
        }
      },
      2, 500
    );
    if (!response.ok) return null;
    const data = await response.json();
    const release = data.releases?.[0];
    if (!release || !release.title) return null;

    const artist = release['artist-credit']?.[0]?.name || release['artist-credit']?.[0]?.artist?.name || null;
    const label = release['label-info']?.[0]?.label?.name || null;
    const aspects = {};
    if (artist) aspects['Artist'] = artist;
    if (label) aspects['Label'] = label;
    if (release.date) aspects['Release Date'] = release.date;
    if (release.country) aspects['Country'] = release.country;

    utils.logAudit("INFO", `MusicBrainz barcode lookup successful: ${release.title}`);
    return {
      title: release.title,
      brand: label || artist || 'Unknown',
      mpn: code,
      stockImageUrls: [],
      aspects,
      source: 'musicbrainz',
      artist
    };
  } catch (err) {
    utils.logAudit("WARN", `MusicBrainz barcode lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Resolves a barcode to catalog data, preferring specialist sources and always
 * degrading gracefully to the existing eBay-catalog path.
 * @param {string} barcode - Raw barcode string from the client.
 * @returns {Promise<object|null>} upcData-compatible object or null.
 */
async function resolveBarcodeData(barcode) {
  const clean = String(barcode || '').trim().replace(/[\s-]/g, '');
  if (!clean) return null;

  // [WAVE1-C] ISBN -> Google Books first, eBay catalog as fallback.
  if (isIsbn13(clean)) {
    const book = await lookupIsbnOnGoogleBooks(clean);
    if (book) return book;
  }

  // Existing eBay catalog path (unchanged).
  const ebayData = await ebayClient.lookupUPCOnEbay(clean);
  if (ebayData) return ebayData;

  // [WAVE1-C] Music fallback for non-ISBN codes: Discogs only with a token,
  // otherwise MusicBrainz. Returns null when nothing is found.
  if (!isIsbn13(clean)) {
    const token = config.getDISCOGS_TOKEN();
    if (token) {
      const discogsData = await lookupBarcodeOnDiscogs(clean, token);
      if (discogsData) return discogsData;
    }
    return await lookupBarcodeOnMusicBrainz(clean);
  }

  return null;
}

let activeRequests = 0;

/**
 * Reads request body with a size limit to prevent Denial of Service (DoS) OOM attacks.
 * @param {http.IncomingMessage} req 
 * @param {number} maxBytes 
 * @returns {Promise<string>}
 */
function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytesReceived = 0;
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        aborted = true;
        req.destroy();
        const err = new Error("Payload Too Large");
        err.statusCode = 413;
        err.code = "PAYLOAD_TOO_LARGE";
        reject(err);
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (!aborted) resolve(body);
    });

    req.on('error', err => {
      reject(err);
    });
  });
}

/**
 * Runs detailed system diagnostics and returns a health report.
 * @returns {Promise<object>}
 */
async function runDiagnosticsHealth() {
  const reports = {};
  
  const checkFolderWritable = (dir) => {
    try {
      const testFile = path.join(dir, `.health-check-${Date.now()}`);
      fs.writeFileSync(testFile, 'ok', 'utf8');
      fs.unlinkSync(testFile);
      return { status: "OK" };
    } catch (e) {
      return { status: "ERROR", message: e.message };
    }
  };

  reports.storage = {
    scratch: checkFolderWritable(path.join(process.cwd(), 'scratch')),
    uploads: checkFolderWritable(config.uploadTempDir),
    data: checkFolderWritable(path.join(process.cwd(), 'data'))
  };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memoryUsage = process.memoryUsage();
  const cpus = os.cpus();
  reports.system = {
    freeMemoryPercentage: ((freeMem / totalMem) * 100).toFixed(2) + "%",
    heapUsedMB: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2),
    heapTotalMB: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2),
    rssMB: (memoryUsage.rss / 1024 / 1024).toFixed(2),
    cpuCores: cpus.length,
    cpuModel: cpus[0]?.model || "unknown",
    loadAvg: os.loadavg(),
    uptimeSeconds: process.uptime().toFixed(0)
  };

  const cbStatus = ebayClient.getCircuitBreakerStatus();
  reports.circuitBreakers = cbStatus.domains || {};

  const isHealthy = reports.storage.scratch.status === "OK" &&
                    reports.storage.uploads.status === "OK" &&
                    reports.storage.data.status === "OK";
                    
  return {
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    details: reports
  };
}

/**
 * Starts the local loopback web server for the eBay Personal Lister dashboard.
 * @param {number} [port=45900] - Server listen port.
 * @returns {http.Server} The running http.Server instance.
 */
function startWebGuiServer(port = 45900) {
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    const traceId = crypto.randomBytes(8).toString('hex');
    utils.asyncLocalStorage.run({ traceId }, async () => {
      activeRequests++;
      const decrementRequests = () => {
        activeRequests--;
      };
      res.on('finish', decrementRequests);
      res.on('close', decrementRequests);

      try {
        const startTime = Date.now();
        const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
        const parsedUrl = new URL(req.url, `http://localhost:${port}`);

        // Host header validation
        const host = req.headers.host || '';
        const isCloudEnv = !!(process.env.RAILWAY_STATIC_URL || process.env.NODE_ENV === 'production' || process.env.ALLOW_EXTERNAL_HOSTS === 'true');
        if (!isCloudEnv && host) {
          const hostClean = host.split(':')[0].toLowerCase();
          if (hostClean !== 'localhost' && hostClean !== '127.0.0.1') {
            utils.logAudit("WARN", `Blocked request with invalid Host header: ${host}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "BAD_REQUEST", message: "Invalid Host header." }));
            return;
          }
        }

        // Hook res.end to record metrics
        const originalEnd = res.end;
        res.end = function (...args) {
          const duration = Date.now() - startTime;
          const pathKey = `${req.method} ${parsedUrl.pathname}`;
          
          if (!metrics.latencyData.has(pathKey)) {
            metrics.latencyData.set(pathKey, []);
          }
          const latencies = metrics.latencyData.get(pathKey);
          latencies.push(duration);
          if (latencies.length > 500) {
            latencies.shift();
          }

          metrics.totalRequests++;
          metrics.endpointCounts[pathKey] = (metrics.endpointCounts[pathKey] || 0) + 1;
          if (res.statusCode >= 400) {
            metrics.endpointErrors[pathKey] = (metrics.endpointErrors[pathKey] || 0) + 1;
          }

          originalEnd.apply(res, args);
        };

        // Security and CORS Headers Checks
        const origin = req.headers.origin;
        if (origin) {
          if (isAllowedOrigin(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
          } else {
            utils.logAudit("WARN", `Blocked CORS request from disallowed origin: ${origin}`);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "FORBIDDEN", message: "Cross-Origin request blocked for security." }));
            return;
          }
        }

        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-lister-api-key');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self';");
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        // Global POST Body Size Limit Interceptor (Middleware)
        if (req.method === 'POST') {
          let limit = 1024 * 1024; // Default 1MB
          if (parsedUrl.pathname === '/api/analyze') {
            limit = 50 * 1024 * 1024; // 50MB for batch Vision analysis
          } else if (parsedUrl.pathname === '/api/images/spruce' || parsedUrl.pathname === '/api/save-draft' || parsedUrl.pathname === '/api/publish') {
            limit = 20 * 1024 * 1024; // 20MB for drafts and single sprucing
          }

          try {
            const bodyStr = await readRequestBody(req, limit);
            
            const origOn = req.on.bind(req);
            const origOnce = req.once.bind(req);
            
            req.on = req.addListener = (event, callback) => {
              if (event === 'data') {
                callback(Buffer.from(bodyStr));
              } else if (event === 'end') {
                process.nextTick(callback);
              } else {
                origOn(event, callback);
              }
              return req;
            };
            req.once = (event, callback) => {
              if (event === 'data') {
                callback(Buffer.from(bodyStr));
              } else if (event === 'end') {
                process.nextTick(callback);
              } else {
                origOnce(event, callback);
              }
              return req;
            };
          } catch (bodyErr) {
            if (bodyErr.statusCode === 413) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "PAYLOAD_TOO_LARGE", message: "Payload size limit exceeded." }));
              return;
            }
            throw bodyErr;
          }
        }

        // Local Request Rate Limiting
        if (parsedUrl.pathname.startsWith('/api/') && !checkRateLimit(clientIp, parsedUrl.pathname)) {
          utils.logAudit("WARN", `Rate limit exceeded by ${clientIp} on ${parsedUrl.pathname}`);
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "TOO_MANY_REQUESTS", message: "Rate limit exceeded. Please slow down." }));
          return;
        }
    
    // Authentication Check Middleware
    const openPaths = [
      '/', '/index.html',
      '/landing', '/landing.html',
      '/privacy', '/privacy.html',
      '/terms', '/terms.html',
      '/press', '/press.html',
      '/health',
      '/api/status',
      '/api/metrics',
      '/api/auth/google/login',
      '/api/auth/google/callback',
      '/api/billing/webhook',
      '/api/billing/mock-success'
    ];
    
    const isApiRoute = parsedUrl.pathname.startsWith('/api/');
    const isAssetRoute = parsedUrl.pathname.endsWith('.js') || parsedUrl.pathname.endsWith('.css') || parsedUrl.pathname.endsWith('.png') || parsedUrl.pathname.endsWith('.jpg') || parsedUrl.pathname.endsWith('.jpeg') || parsedUrl.pathname.endsWith('.webp');
    
    const user = getAuthenticatedUser(req);
    const isAuthRequired = config.getGOOGLE_CLIENT_ID() && !openPaths.includes(parsedUrl.pathname) && !isAssetRoute;
    
    if (isAuthRequired && !user) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "UNAUTHORIZED", message: "Please log in using Google Sign-In." }));
      return;
    }
    
    // Serve Press Page
    if (req.method === 'GET' && (parsedUrl.pathname === '/press' || parsedUrl.pathname === '/press.html')) {
      const pressPath = path.join(__dirname, 'public', 'press.html');
      try {
        const content = fs.readFileSync(pressPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading press kit: ${err.message}`);
      }
      return;
    }
    
    // Serve Privacy Page
    if (req.method === 'GET' && (parsedUrl.pathname === '/privacy' || parsedUrl.pathname === '/privacy.html')) {
      const privacyPath = path.join(__dirname, 'public', 'privacy.html');
      try {
        const content = fs.readFileSync(privacyPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading privacy policy: ${err.message}`);
      }
      return;
    }

    // Serve Terms Page
    if (req.method === 'GET' && (parsedUrl.pathname === '/terms' || parsedUrl.pathname === '/terms.html')) {
      const termsPath = path.join(__dirname, 'public', 'terms.html');
      try {
        const content = fs.readFileSync(termsPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading terms of service: ${err.message}`);
      }
      return;
    }

    // Serve Landing Page
    if (req.method === 'GET' && (parsedUrl.pathname === '/landing' || parsedUrl.pathname === '/landing.html')) {
      const landingPath = path.join(__dirname, 'public', 'landing.html');
      try {
        const content = fs.readFileSync(landingPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading landing page: ${err.message}`);
      }
      return;
    }

    // Serve Dashboard HTML
    if (req.method === 'GET' && (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html')) {
      const htmlPath = path.join(__dirname, 'public', 'index.html');
      try {
        const content = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading GUI: ${err.message}`);
      }
      return;
    }

    // API: Search category suggestions
    if (req.method === 'GET' && parsedUrl.pathname === '/api/categories/search') {
      const q = parsedUrl.searchParams.get('q');
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Missing query parameter: q" }));
        return;
      }
      try {
        const suggestions = await ebayClient.getCategorySuggestions(q);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(suggestions));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── EBAY OAUTH & CONFIG ENDPOINTS ──

    // API: eBay OAuth Redirect Login
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/ebay/login') {
      const clientId = config.getEBAY_CLIENT_ID();
      const ruName = config.getEBAY_RUNAME() || "your_ebay_ru_name";
      if (!clientId || clientId === 'your_ebay_client_id') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Missing eBay Client ID" }));
        return;
      }
      
      const scopes = encodeURIComponent("https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account");
      const ebayAuthUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${ruName}&response_type=code&scope=${scopes}`;
      res.writeHead(302, { 'Location': ebayAuthUrl });
      res.end();
      return;
    }

    // API: eBay OAuth Callback
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/ebay/callback') {
      const code = parsedUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(302, { 'Location': '/?error=ebay_code_missing' });
        res.end();
        return;
      }
      
      try {
        const clientId = config.getEBAY_CLIENT_ID();
        const clientSecret = config.getEBAY_CLIENT_SECRET();
        const ruName = config.getEBAY_RUNAME() || "your_ebay_ru_name";
        
        const tokenUrl = "https://api.ebay.com/identity/v1/oauth2/token";
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const payload = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ruName
        }).toString();
        
        const tokenRes = await ebayClient.fetchWithRetry(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${credentials}`
          },
          body: payload
        });
        
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok) {
          throw new Error(`eBay token exchange failed: ${JSON.stringify(tokenData)}`);
        }
        
        const newRefreshToken = tokenData.refresh_token;
        const newAccessToken = tokenData.access_token;
        
        ebayClient.setAccessToken(newAccessToken);
        process.env.EBAY_REFRESH_TOKEN = newRefreshToken;
        
        let envContent = '';
        if (fs.existsSync(config.envPath)) {
          envContent = fs.readFileSync(config.envPath, 'utf8');
        }
        let lines = envContent.split(/\r?\n/);
        const index = lines.findIndex(l => l.trim().startsWith('EBAY_REFRESH_TOKEN=') || l.trim().startsWith('#EBAY_REFRESH_TOKEN='));
        if (index !== -1) {
          lines[index] = `EBAY_REFRESH_TOKEN=${newRefreshToken}`;
        } else {
          lines.push(`EBAY_REFRESH_TOKEN=${newRefreshToken}`);
        }
        fs.writeFileSync(config.envPath, lines.join('\n'), 'utf8');
        utils.logAudit("INFO", "eBay OAuth connection successful. Refresh token updated.");
        
        res.writeHead(302, { 'Location': '/?ebay_auth=success' });
        res.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`eBay Authentication Error: ${err.message}`);
      }
      return;
    }

    // API: Get location info
    if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/location') {
      try {
        const key = config.getEBAY_LOCATION_KEY();
        const data = await ebayClient.getInventoryLocation(key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, locationKey: config.getEBAY_LOCATION_KEY() }));
      }
      return;
    }
    
    // API: Save/Create location info
    if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/location') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData || '{}');
          const key = payload.locationKey || config.getEBAY_LOCATION_KEY();
          const result = await ebayClient.createInventoryLocation(key, payload.locationDetails);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Get condition policies per category
    if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/conditions') {
      const categoryId = parsedUrl.searchParams.get('categoryId');
      if (!categoryId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Missing categoryId" }));
        return;
      }
      try {
        const conditions = await ebayClient.getItemConditionPolicies(categoryId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(conditions));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Get item aspects metadata per category
    if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/aspects') {
      const categoryId = parsedUrl.searchParams.get('categoryId');
      if (!categoryId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Missing categoryId" }));
        return;
      }
      try {
        const metadata = await ebayClient.getItemAspectsMetadata(categoryId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metadata));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Relist/Clone ended listing into draft
    if (req.method === 'POST' && parsedUrl.pathname === '/api/relist') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData || '{}');
          const { sku } = payload;
          if (!sku) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing required parameter: sku" }));
            return;
          }
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const existing = history.find(item => item.sku === sku);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "SKU not found" }));
            return;
          }
          const newSku = `${config.getSKU_PREFIX()}SKU-${Date.now()}`;
          const newDraft = {
            ...existing,
            sku: newSku,
            status: "DRAFT",
            listingId: null,
            offerId: null,
            timestamp: new Date().toISOString(),
            listingDetails: existing.listingDetails ? {
              ...existing.listingDetails,
              suggestedPrice: existing.price
            } : null
          };
          history.push(newDraft);
          utils.writeJsonFileSecure(config.historyPath, history);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, sku: newSku }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Autosave draft listing
    if (req.method === 'POST' && parsedUrl.pathname === '/api/draft/autosave') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const finalListing = payload.listing;
          let sku = payload.sku;
          if (!sku) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing SKU" }));
            return;
          }
          if (finalListing) {
            geminiClient.validateAndFixListingSchema(finalListing);
            if (finalListing.description) {
              finalListing.description = utils.stripScriptsAndIframes(finalListing.description);
            }
            const listingDetails = {
              ...finalListing,
              imageUrls: payload.imageUrls || []
            };
            const history = utils.readJsonFileSecure(config.historyPath, []);
            const existingIndex = history.findIndex(item => item.sku === sku);
            if (existingIndex !== -1) {
              history[existingIndex].timestamp = new Date().toISOString();
              history[existingIndex].title = finalListing.title;
              history[existingIndex].price = parseFloat(finalListing.suggestedPrice) || 0;
              history[existingIndex].categoryId = finalListing.categoryId;
              history[existingIndex].brand = finalListing.brand || "Generic";
              history[existingIndex].listingDetails = listingDetails;
              utils.writeJsonFileSecure(config.historyPath, history);
            } else {
              utils.saveListingToHistory(sku, null, finalListing.title, finalListing.suggestedPrice || 0, finalListing.categoryId, null, null, "DRAFT", listingDetails);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Google OAuth Redirect Login
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/google/login') {
      const clientId = config.getGOOGLE_CLIENT_ID();
      const redirectUri = encodeURIComponent(config.getGOOGLE_REDIRECT_URI());
      if (!clientId) {
        // Auto-login mock for local dev
        const sessionId = crypto.randomBytes(32).toString('hex');
        const userObj = { email: "local-admin@lister.pro", isPremium: true };
        activeSessions.set(sessionId, { user: userObj, expiresAt: Date.now() + 86400000 });
        
        res.writeHead(302, {
          'Set-Cookie': `sessionId=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
          'Location': '/'
        });
        res.end();
        return;
      }
      
      const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=openid%20email%20profile`;
      res.writeHead(302, { 'Location': googleAuthUrl });
      res.end();
      return;
    }

    // API: Google OAuth Callback
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/google/callback') {
      const code = parsedUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(302, { 'Location': '/?error=code_missing' });
        res.end();
        return;
      }
      
      try {
        const tokenUrl = "https://oauth2.googleapis.com/token";
        const payload = new URLSearchParams({
          code,
          client_id: config.getGOOGLE_CLIENT_ID(),
          client_secret: config.getGOOGLE_CLIENT_SECRET(),
          redirect_uri: config.getGOOGLE_REDIRECT_URI(),
          grant_type: "authorization_code"
        }).toString();
        
        const tokenRes = await ebayClient.fetchWithRetry(tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: payload
        });
        
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok) {
          throw new Error(`Google token exchange failed: ${JSON.stringify(tokenData)}`);
        }
        
        const accessToken = tokenData.access_token;
        const userInfoRes = await ebayClient.fetchWithRetry("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { "Authorization": `Bearer ${accessToken}` }
        });
        
        const userInfo = await userInfoRes.json();
        if (!userInfoRes.ok) {
          throw new Error(`Google userinfo failed: ${JSON.stringify(userInfo)}`);
        }
        
        const email = userInfo.email;
        const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
        const billingHistory = utils.readJsonFileSecure(billingDbPath, {});
        const isPremium = !!(billingHistory[email] && billingHistory[email].premium);
        
        const sessionId = crypto.randomBytes(32).toString('hex');
        const userObj = { email, name: userInfo.name, picture: userInfo.picture, isPremium };
        activeSessions.set(sessionId, { user: userObj, expiresAt: Date.now() + 86400000 });
        
        res.writeHead(302, {
          'Set-Cookie': `sessionId=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
          'Location': '/'
        });
        res.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Authentication Error: ${err.message}`);
      }
      return;
    }

    // API: Logout
    if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/logout') {
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies.sessionId;
      if (sessionId) {
        activeSessions.delete(sessionId);
      }
      res.writeHead(200, {
        'Set-Cookie': `sessionId=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API: Delete Account (GDPR / CCPA compliance Right to Erasure)
    if (req.method === 'DELETE' && parsedUrl.pathname === '/api/user/account') {
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies.sessionId;
      let email = null;
      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId);
        email = session.user?.email;
        activeSessions.delete(sessionId);
      }
      
      if (email) {
        const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
        const billingHistory = utils.readJsonFileSecure(billingDbPath, {});
        if (billingHistory[email]) {
          delete billingHistory[email];
          utils.writeJsonFileSecure(billingDbPath, billingHistory);
        }
        utils.logAudit("INFO", `Account data deleted for user: ${email}`);
      }

      res.writeHead(200, {
        'Set-Cookie': `sessionId=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({ success: true, message: "User session and billing record deleted." }));
      return;
    }

    // API: Session info
    if (req.method === 'GET' && parsedUrl.pathname === '/api/auth/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        authenticated: !!user, 
        user: user || null,
        googleLoginEnabled: !!config.getGOOGLE_CLIENT_ID()
      }));
      return;
    }

    // API: Stripe Checkout Session creation
    if (req.method === 'POST' && parsedUrl.pathname === '/api/billing/create-checkout-session') {
      const stripeSecret = config.getSTRIPE_SECRET_KEY();
      if (!stripeSecret) {
        // Dev mock fallback if Stripe not configured
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: '/api/billing/mock-success' }));
        return;
      }
      
      try {
        const userEmail = user ? user.email : "customer@local.lister";
        const stripePayload = new URLSearchParams({
          "success_url": `http://localhost:${port}/?billing=success`,
          "cancel_url": `http://localhost:${port}/?billing=cancel`,
          "mode": "subscription",
          "customer_email": userEmail,
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][product_data][name]": "Lister Pro Premium Subscription",
          "line_items[0][price_data][unit_amount]": "2900", // $29.00
          "line_items[0][price_data][recurring][interval]": "month",
          "line_items[0][quantity]": "1"
        }).toString();
        
        const stripeRes = await ebayClient.fetchWithRetry("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Basic ${Buffer.from(stripeSecret + ':').toString('base64')}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: stripePayload
        });
        
        const stripeData = await stripeRes.json();
        if (!stripeRes.ok) {
          throw new Error(`Stripe API error: ${JSON.stringify(stripeData)}`);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: stripeData.url }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Stripe Mock Success
    if (req.method === 'GET' && parsedUrl.pathname === '/api/billing/mock-success') {
      if (user) {
        user.isPremium = true;
        const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
        const billingHistory = utils.readJsonFileSecure(billingDbPath, {});
        billingHistory[user.email] = { premium: true, subscriptionId: "mock-sub-12345", plan: "pro" }; // [WAVE1-D] plan recorded for entitlements
        utils.writeJsonFileSecure(billingDbPath, billingHistory);
      }
      res.writeHead(302, { 'Location': '/?billing=success' });
      res.end();
      return;
    }

    // API: Stripe Webhook
    if (req.method === 'POST' && parsedUrl.pathname === '/api/billing/webhook') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const signatureHeader = req.headers['stripe-signature'];
          const webhookSecret = config.getSTRIPE_WEBHOOK_SECRET();
          
          if (webhookSecret && signatureHeader) {
            const sigParts = signatureHeader.split(',');
            const timestampPart = sigParts.find(p => p.startsWith('t='));
            const signaturePart = sigParts.find(p => p.startsWith('v1='));
            
            if (!timestampPart || !signaturePart) throw new Error("Invalid signature headers");
            
            const timestamp = timestampPart.split('=')[1];
            const signature = signaturePart.split('=')[1];
            const signedPayload = `${timestamp}.${bodyData}`;
            
            const expectedSignature = crypto
              .createHmac('sha256', webhookSecret)
              .update(signedPayload)
              .digest('hex');
              
            if (signature !== expectedSignature) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Invalid Stripe signature" }));
              return;
            }
          }

          const event = JSON.parse(bodyData);
          const billingDbPath = path.join(process.cwd(), 'scratch', 'billing_status.json');
          const billingHistory = utils.readJsonFileSecure(billingDbPath, {});

          if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const email = session.customer_email || session.customer_details?.email;
            if (email) {
              // [WAVE1-D] Record the billing plan from checkout metadata
              // (plan: "pro" | "power_seller") so team-seat entitlements can
              // be enforced. Defaults to "pro" for sessions without metadata.
              const plan = (session.metadata && session.metadata.plan) || "pro";
              billingHistory[email] = { premium: true, subscriptionId: session.subscription, plan };
              utils.writeJsonFileSecure(billingDbPath, billingHistory);
              utils.logAudit("INFO", `Stripe Premium Activated for customer: ${email} (plan: ${plan})`);
              for (const [sid, sess] of activeSessions.entries()) {
                if (sess.user.email === email) {
                  sess.user.isPremium = true;
                }
              }
            }
          } else if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            for (const email of Object.keys(billingHistory)) {
              if (billingHistory[email].subscriptionId === subscription.id) {
                billingHistory[email].premium = false;
                utils.writeJsonFileSecure(billingDbPath, billingHistory);
                utils.logAudit("INFO", `Stripe Premium Expired for customer: ${email}`);
                for (const [sid, sess] of activeSessions.entries()) {
                  if (sess.user.email === email) {
                    sess.user.isPremium = false;
                  }
                }
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // [WAVE1-D] API: Team workspace status for the logged-in user.
    if (req.method === 'GET' && parsedUrl.pathname === '/api/team') {
      if (!user || !user.email) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Login required." }));
        return;
      }
      const ws = getWorkspaceFor(user.email);
      const billing = getBillingPlan(user.email);
      const maxSeats = getTeamMaxSeats(billing.plan);
      if (!ws) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ role: "none", owner: null, plan: billing.plan, maxSeats, members: [] }));
        return;
      }
      const store = readTeamStore();
      const record = store[ws.owner] || { members: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        role: ws.role, owner: ws.owner, plan: billing.plan,
        maxSeats: getTeamMaxSeats("power_seller"),
        usedSeats: countUsedSeats(record),
        members: record.members
      }));
      return;
    }

    // [WAVE1-D] Helper: parse a JSON body, 400 on malformed input.
    function parseTeamJsonBody(bodyData, res) {
      try {
        return JSON.parse(bodyData);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Malformed JSON payload" }));
        return null;
      }
    }

    // [WAVE1-D] API: Invite a member to the owner's workspace (owner only).
    if (req.method === 'POST' && parsedUrl.pathname === '/api/team/invite') {
      if (!user || !user.email) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Login required." }));
        return;
      }
      const ws = getWorkspaceFor(user.email);
      if (!ws || ws.role !== "owner") {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Only the workspace owner can invite members." }));
        return;
      }
      let bodyData = '';
      req.on('data', chunk => { bodyData += chunk; });
      req.on('end', async () => {
        const payload = parseTeamJsonBody(bodyData, res);
        if (!payload) return;
        try {
          const member = inviteTeamMember(user.email, payload.email);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, member }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // [WAVE1-D] API: Remove a member from the workspace (owner only).
    if (req.method === 'POST' && parsedUrl.pathname === '/api/team/remove') {
      if (!user || !user.email) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Login required." }));
        return;
      }
      const ws = getWorkspaceFor(user.email);
      if (!ws || ws.role !== "owner") {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Only the workspace owner can remove members." }));
        return;
      }
      let bodyData = '';
      req.on('data', chunk => { bodyData += chunk; });
      req.on('end', async () => {
        const payload = parseTeamJsonBody(bodyData, res);
        if (!payload) return;
        try {
          removeTeamMember(user.email, payload.email);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // [WAVE1-D] API: Accept a pending team invite (invitee must be logged in).
    if (req.method === 'POST' && parsedUrl.pathname === '/api/team/accept') {
      if (!user || !user.email) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Login required." }));
        return;
      }
      let bodyData = '';
      req.on('data', chunk => { bodyData += chunk; });
      req.on('end', async () => {
        const payload = parseTeamJsonBody(bodyData, res);
        if (!payload) return;
        try {
          const member = acceptTeamInvite(payload.owner, user.email);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, member }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // [WAVE1-D] API: Leave the current team workspace.
    if (req.method === 'POST' && parsedUrl.pathname === '/api/team/leave') {
      if (!user || !user.email) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Login required." }));
        return;
      }
      const left = leaveTeam(user.email);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, left }));
      return;
    }

    // API: WooCommerce Cross-Post
    if (req.method === 'POST' && parsedUrl.pathname === '/api/publish/woocommerce') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        let sku, listing, imageUrls;
        try {
          const payload = JSON.parse(bodyData);
          ({ sku, listing, imageUrls } = payload);
          
          const wcUrlStr = config.getWOOCOMMERCE_URL();
          const wcKey = config.getWOOCOMMERCE_KEY();
          const wcSecret = config.getWOOCOMMERCE_SECRET();
          
          if (!wcUrlStr || !wcKey || !wcSecret) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "WooCommerce not configured." }));
            return;
          }
          
          const wcPayload = {
            name: listing.title,
            type: "simple",
            regular_price: String(listing.suggestedPrice),
            description: listing.description,
            short_description: "Multichannel listing from eBay Lister",
            manage_stock: true,
            stock_quantity: 1,
            sku: sku,
            images: imageUrls.map(url => ({ src: url }))
          };
          
          const auth = Buffer.from(`${wcKey}:${wcSecret}`).toString('base64');
          const wcRes = await ebayClient.fetchWithRetry(`${wcUrlStr}/wp-json/wc/v3/products`, {
            method: "POST",
            headers: {
              "Authorization": `Basic ${auth}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(wcPayload)
          });
          
          const wcData = await wcRes.json();
          if (!wcRes.ok) {
            throw new Error(`WooCommerce API error: ${JSON.stringify(wcData)}`);
          }
          
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const item = history.find(i => i.sku === sku);
          if (item) {
            item.woocommerceId = String(wcData.id);
            utils.writeJsonFileSecure(config.historyPath, history);
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: wcData.id }));
        } catch (e) {
          crossPost.addToDlq("woocommerce", sku, listing, imageUrls || [], e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Etsy Cross-Post
    if (req.method === 'POST' && parsedUrl.pathname === '/api/publish/etsy') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        let sku, listing;
        try {
          const payload = JSON.parse(bodyData);
          ({ sku, listing } = payload);
          
          const etsyShopId = config.getETSY_SHOP_ID();
          const etsyToken = config.getETSY_ACCESS_TOKEN();
          const etsyClientId = config.getEBAY_CLIENT_ID();
          
          if (!etsyShopId || !etsyToken) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Etsy shop settings not configured." }));
            return;
          }
          
          const etsyPayload = {
            quantity: 1,
            title: listing.title.slice(0, 140),
            description: listing.description,
            price: listing.suggestedPrice,
            who_made: "i_did",
            when_made: "made_to_order",
            taxonomy_id: 1,
            is_personalizable: false
          };
          
          const etsyRes = await ebayClient.fetchWithRetry(`https://api.etsy.com/v3/application/shops/${etsyShopId}/listings`, {
            method: "POST",
            headers: {
              "x-api-key": etsyClientId || "mock-etsy-client-id",
              "Authorization": `Bearer ${etsyToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(etsyPayload)
          });
          
          const etsyData = await etsyRes.json();
          if (!etsyRes.ok) {
            throw new Error(`Etsy API error: ${JSON.stringify(etsyData)}`);
          }
          
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const item = history.find(i => i.sku === sku);
          if (item) {
            item.etsyId = String(etsyData.listing_id);
            utils.writeJsonFileSecure(config.historyPath, history);
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: etsyData.listing_id }));
        } catch (e) {
          crossPost.addToDlq("etsy", sku, listing, [], e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Auto-Offer to Watchers
    if (req.method === 'POST' && parsedUrl.pathname === '/api/offers/auto-send') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData);
          const { sku, discountPercentage = 10 } = payload;
          
          if (!sku) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing required field: sku" }));
            return;
          }
          
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const item = history.find(i => i.sku === sku);
          
          if (!item) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "SKU not found" }));
            return;
          }
          
          if (item.status !== 'ACTIVE' || !item.listingId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Item is not active on eBay" }));
            return;
          }
          
          await ebayClient.refreshEbayAccessToken();
          const result = await ebayClient.sendOffersToWatchers(item.listingId, discountPercentage);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Poshmark & Mercari Export Details
    if (req.method === 'POST' && (parsedUrl.pathname === '/api/export/mercari' || parsedUrl.pathname === '/api/export/poshmark')) {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData);
          const { sku } = payload;
          const history = utils.readJsonFileSecure(config.historyPath, []);
          const item = history.find(i => i.sku === sku);
          if (!item) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "SKU not found." }));
            return;
          }
          
          const platform = parsedUrl.pathname.includes('mercari') ? "Mercari" : "Poshmark";
          // [WAVE1-A] Prefer seller-entered keywords for cross-list tags; fall back to title words.
          // Private fields (internalNotes, costOfGoods) are never included in export payloads.
          const storedKeywords = (item.listingDetails && Array.isArray(item.listingDetails.keywords))
            ? item.listingDetails.keywords.filter(k => typeof k === 'string' && k.trim()).slice(0, 13)
            : [];
          const exportData = {
            title: item.title,
            description: item.description,
            price: item.price,
            sku: item.sku,
            brand: item.brand || "Generic",
            suggestedTags: storedKeywords.length > 0 ? storedKeywords.join(', ') : item.title.split(' ').slice(0, 3).join(', ')
          };
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            platform, 
            sku, 
            copyPaste: exportData,
            images: item.imageUrls || [] 
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // [WAVE1-A] API: Listing templates — list saved templates
    if (req.method === 'GET' && parsedUrl.pathname === '/api/templates') {
      try {
        const templates = utils.readJsonFileSecure(config.templatesPath, []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ templates }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // [WAVE1-A] API: Listing templates — save a new template from a field set
    if (req.method === 'POST' && parsedUrl.pathname === '/api/templates') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(bodyData);
          const name = typeof payload.name === 'string' ? payload.name.trim() : '';
          const fields = payload.fields;
          if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Template name is required." }));
            return;
          }
          if (!fields || typeof fields !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Template fields object is required." }));
            return;
          }
          const templates = utils.readJsonFileSecure(config.templatesPath, []);
          // Private fields travel with templates (local storage only) but are
          // stripped from every outbound marketplace payload at publish time.
          templates.push({ name, createdAt: new Date().toISOString(), fields });
          utils.writeJsonFileSecure(config.templatesPath, templates);
          utils.logAudit("INFO", `Saved listing template "${name}".`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, name }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Get Listings History
    if (req.method === 'GET' && parsedUrl.pathname === '/api/history') {
      const data = utils.readJsonFileSecure(config.historyPath, []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        listings: data,
        shopifyShopName: config.getSHOPIFY_SHOP_NAME() || null,
        woocommerceUrl: config.getWOOCOMMERCE_URL() || null,
        etsyShopId: config.getETSY_SHOP_ID() || null
      }));
      return;
    }

    // API: Fetch eBay custom business policies
    if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/policies') {
      try {
        const policies = await ebayClient.getEbayPolicies();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(policies));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Fetch eBay Marketing Campaigns Summary
    if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/marketing/summary') {
      try {
        const summary = await ebayClient.getMarketingSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    // API: Import listings from eBay Browse API ("Sell Similar")
    if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/import') {
      const targetInput = parsedUrl.searchParams.get('itemIdOrUrl') || "";
      
      // Parse item ID (e.g. extracts a 12-digit number from URL or raw input)
      const match = targetInput.match(/(?:\/itm\/|active\/|item\/|v1\|)?(\d{11,13})/i);
      let itemId = match ? match[1] : targetInput.trim();
      const isOriginalKeywordSearch = !match;

      // Helper function to handle Gemini fallback
      const handleGeminiListingFallback = async (keywords, response) => {
        try {
          const geminiListing = await geminiClient.generateListingFromKeywords(keywords);
          let stockPhotos = [];
          try {
            stockPhotos = await ebayClient.searchCatalogStockPhotos(geminiListing.title || keywords);
          } catch (pErr) {
            utils.logAudit("WARN", `Failed to fetch stock photos for Gemini generated listing: ${pErr.message}`);
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            title: geminiListing.title,
            suggestedPrice: geminiListing.suggestedPrice,
            condition: geminiListing.condition,
            brand: geminiListing.brand,
            model: geminiListing.model,
            weightMajor: geminiListing.weightMajor || 1,
            weightMinor: geminiListing.weightMinor || 0,
            packageLength: geminiListing.packageLength || 10,
            packageWidth: geminiListing.packageWidth || 8,
            packageHeight: geminiListing.packageHeight || 6,
            description: geminiListing.description,
            categoryId: geminiListing.categoryId || "111422",
            aspects: geminiListing.aspects || {},
            imageUrls: stockPhotos
          }));
        } catch (geminiErr) {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: `Listing generation failed: ${geminiErr.message}` }));
        }
      };

      if (!itemId || !/^\d{11,13}$/.test(itemId)) {
        if (!targetInput.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Please enter an eBay Item ID, URL, or product keywords." }));
          return;
        }
        try {
          const foundId = await ebayClient.searchItemIdByKeywords(targetInput.trim());
          if (foundId) {
            itemId = foundId;
          }
        } catch (err) {
          utils.logAudit("WARN", `eBay Browse API search failed for keywords "${targetInput}": ${err.message}. Falling back to Gemini AI generation.`);
        }
      }

      // If we don't have a valid Item ID after searching, use Gemini AI generation directly
      if (!itemId || !/^\d{11,13}$/.test(itemId)) {
        utils.logAudit("INFO", `No valid Item ID found. Using Gemini AI generation for "${targetInput}"`);
        await handleGeminiListingFallback(targetInput.trim(), res);
        return;
      }

      try {
        const item = await ebayClient.getItemFromBrowse(itemId);
        
        // Map Browse API item fields to editor schema
        const brand = item.brand || "";
        const model = item.mpn || item.model || "";
        
        const aspects = {};
        if (Array.isArray(item.localizedAspects)) {
          item.localizedAspects.forEach(a => {
            aspects[a.name] = a.value;
          });
        }

        const imageUrls = [];
        if (item.image && item.image.imageUrl) {
          imageUrls.push(item.image.imageUrl);
        }
        if (Array.isArray(item.additionalImages)) {
          item.additionalImages.forEach(img => {
            if (img.imageUrl && !imageUrls.includes(img.imageUrl)) {
              imageUrls.push(img.imageUrl);
            }
          });
        }

        const listingData = {
          title: item.title || "",
          suggestedPrice: item.price ? parseFloat(item.price.value) : 10.00,
          condition: "USED_GOOD",
          brand: brand,
          model: model,
          categoryId: item.categoryId || "",
          weightMajor: 1,
          weightMinor: 0,
          packageLength: 10,
          packageWidth: 8,
          packageHeight: 6,
          description: item.description || "",
          aspects: aspects,
          imageUrls: imageUrls
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(listingData));
      } catch (err) {
        utils.logAudit("WARN", `Failed to get item details from Browse API: ${err.message}`);
        // If this was a keyword search, fallback to Gemini instead of returning 500
        if (isOriginalKeywordSearch) {
          utils.logAudit("INFO", `Falling back to Gemini AI generation for "${targetInput}"`);
          await handleGeminiListingFallback(targetInput.trim(), res);
        } else {
          sendError(res, new Error(`Failed to import eBay listing details: ${err.message}`), 500);
        }
      }
      return;
    }

    // API: Real-time logs SSE stream
    if (req.method === 'GET' && parsedUrl.pathname === '/api/logs/stream') {
      const logPath = config.logPath;
      if (!fs.existsSync(logPath)) {
        try { fs.writeFileSync(logPath, '', 'utf8'); } catch (e) {}
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('\n'); // keep connection alive

      let filePosition = 0;
      if (fs.existsSync(logPath)) {
        filePosition = fs.statSync(logPath).size;
      }

      const watcher = fs.watch(logPath, (eventType) => {
        if (eventType === 'change') {
          try {
            const stats = fs.statSync(logPath);
            if (stats.size > filePosition) {
              const fd = fs.openSync(logPath, 'r');
              const bufferSize = stats.size - filePosition;
              const buffer = Buffer.alloc(bufferSize);
              fs.readSync(fd, buffer, 0, bufferSize, filePosition);
              fs.closeSync(fd);
              filePosition = stats.size;

              const lines = buffer.toString('utf8').split('\n').filter(l => l.trim().length > 0);
              for (const line of lines) {
                res.write(`data: ${line}\n\n`);
              }
            } else if (stats.size < filePosition) {
              filePosition = stats.size;
            }
          } catch (e) {
            // handle error silently
          }
        }
      });

      req.on('close', () => {
        watcher.close();
      });
      return;
    }


    // API: Delete Listing Entry (for purging drafts or local entries)
    if (req.method === 'DELETE' && parsedUrl.pathname === '/api/history') {
      const targetSku = parsedUrl.searchParams.get('sku');
      if (!targetSku) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Missing required query parameter: sku" }));
        return;
      }

      try {
        const history = utils.readJsonFileSecure(config.historyPath, []);
        const initialLength = history.length;
        const filtered = history.filter(item => item.sku !== targetSku);

        if (filtered.length === initialLength) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "SKU not found in history" }));
          return;
        }

        utils.writeJsonFileSecure(config.historyPath, filtered);
        utils.logAudit("INFO", `Deleted SKU ${targetSku} from history`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `SKU ${targetSku} successfully removed.` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Get VeRO Brands
    if (req.method === 'GET' && parsedUrl.pathname === '/api/vero-brands') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ brands: config.getVERO_BRANDS() }));
      return;
    }

    // API: Update Repricer Configuration
    if (req.method === 'POST' && parsedUrl.pathname === '/api/repricer') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData || '{}');
          const { sku, priceFloor, priceCap, priceLocked } = payload;
          if (!sku) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing required parameter: sku" }));
            return;
          }

          const history = utils.readJsonFileSecure(config.historyPath, []);
          const existingIndex = history.findIndex(item => item.sku === sku);
          if (existingIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "SKU not found in history" }));
            return;
          }

          let parsedFloor = null;
          if (priceFloor !== undefined && priceFloor !== null && priceFloor !== '') {
            parsedFloor = parseFloat(priceFloor);
            if (isNaN(parsedFloor) || parsedFloor < 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Invalid priceFloor: must be a positive number" }));
              return;
            }
          }

          let parsedCap = null;
          if (priceCap !== undefined && priceCap !== null && priceCap !== '') {
            parsedCap = parseFloat(priceCap);
            if (isNaN(parsedCap) || parsedCap < 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Invalid priceCap: must be a positive number" }));
              return;
            }
          }

          if (parsedFloor !== null && parsedCap !== null && parsedFloor > parsedCap) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "priceFloor cannot be greater than priceCap" }));
            return;
          }

          // Update settings
          history[existingIndex].priceFloor = parsedFloor;
          history[existingIndex].priceCap = parsedCap;
          history[existingIndex].priceLocked = !!priceLocked;
          history[existingIndex].timestamp = new Date().toISOString();

          utils.writeJsonFileSecure(config.historyPath, history);
          utils.logAudit("INFO", `Updated repricer config for SKU ${sku}: Floor=${parsedFloor}, Cap=${parsedCap}, Locked=${!!priceLocked}`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            sku, 
            priceFloor: parsedFloor, 
            priceCap: parsedCap, 
            priceLocked: !!priceLocked 
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Run Repricer Tool Immediately
    if (req.method === 'POST' && parsedUrl.pathname === '/api/repricer/run') {
      try {
        await ebayClient.runDailyRepricer();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/dlq') {
      try {
        const summary = await crossPost.getDlqSummary();
        const entries = await crossPost.getDlqEntries();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, summary, entries }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/dlq/process') {
      try {
        const result = await crossPost.processPendingSyncsDlq();
        const summary = await crossPost.getDlqSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result, summary }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/dlq/action') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData || '{}');
          const { action, sku, platform, force } = payload;

          if (!action) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: action' }));
            return;
          }

          if (action === 'clear') {
            if (!payload.confirm) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Set confirm: true to clear the entire sync queue' }));
              return;
            }
            const removedCount = await crossPost.clearDlq();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, removedCount, summary: await crossPost.getDlqSummary() }));
            return;
          }

          if (!sku || !platform) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required fields: sku, platform' }));
            return;
          }

          if (action === 'retry') {
            const result = await crossPost.retryDlqJob(sku, platform, { force: !!force });
            const summary = await crossPost.getDlqSummary();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, result, summary }));
            return;
          }

          if (action === 'dismiss') {
            const removed = await crossPost.removeFromDlq(sku, platform);
            if (!removed) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'DLQ job not found' }));
              return;
            }
            const summary = await crossPost.getDlqSummary();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, summary }));
            return;
          }

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid action. Use retry, dismiss, or clear.' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Health check
    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      try {
        const report = await runDiagnosticsHealth();
        res.writeHead(report.status === 'ok' ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
      return;
    }

    // API: Get Status
    if (req.method === 'GET' && parsedUrl.pathname === '/api/status') {
      const circuitBreaker = ebayClient.getCircuitBreakerStatus();
      const diagnosticsOk = (() => {
        try {
          return config.runDiagnostics();
        } catch (e) {
          return false;
        }
      })();
      const statusInfo = {
        status: circuitBreaker.active ? "RATE_LIMITED" : "CONNECTED",
        circuitBreaker,
        diagnostics: diagnosticsOk ? "OK" : "FAILED",
        ebayAuthenticated: !!ebayClient.getAccessToken(),
        shopifyConnected: !!(config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()),
        woocommerceConnected: !!(config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()),
        etsyConnected: !!(config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN()),
        dlq: await crossPost.getDlqSummary()
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(statusInfo));
      return;
    }

    // API: Get Metrics
    if (req.method === 'GET' && parsedUrl.pathname === '/api/metrics') {
      const activeLatencies = {};
      for (const [pathKey, list] of metrics.latencyData.entries()) {
        if (list.length > 0) {
          const sum = list.reduce((a, b) => a + b, 0);
          activeLatencies[pathKey] = {
            count: list.length,
            avgMs: Math.round(sum / list.length),
            minMs: Math.min(...list),
            maxMs: Math.max(...list)
          };
        }
      }

      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptime: Math.round(process.uptime()),
        totalRequests: metrics.totalRequests,
        endpointCounts: metrics.endpointCounts,
        endpointErrors: metrics.endpointErrors,
        latencies: activeLatencies,
        memoryUsage: {
          rss: Math.round(memory.rss / 1024 / 1024) + ' MB',
          heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + ' MB',
          heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + ' MB',
          external: Math.round(memory.external / 1024 / 1024) + ' MB'
        },
        cpuUsage: cpu,
        activeSockets: activeSockets.size,
        circuitBreakers: ebayClient.getCircuitBreakerStatus().domains
      }, null, 2));
      return;
    }

    // API: Get logs
    if (req.method === 'GET' && parsedUrl.pathname === '/api/logs') {
      try {
        const logFilePath = config.logPath;
        let logsText = "";
        if (fs.existsSync(logFilePath)) {
          const fileContent = fs.readFileSync(logFilePath, 'utf8');
          const lines = fileContent.split('\n').filter(l => l.trim().length > 0);
          const formattedLines = lines.slice(-50).map(line => {
            try {
              const log = JSON.parse(line);
              const tracePart = log.traceId ? ` [Trace: ${log.traceId}]` : '';
              const dataPart = log.data ? ` | Data: ${JSON.stringify(log.data)}` : '';
              return `[${log.timestamp}] [${log.level}]${tracePart} ${log.message}${dataPart}`;
            } catch (e) {
              return line;
            }
          });
          logsText = formattedLines.join('\n');
        } else {
          logsText = "No system logs found.";
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs: logsText }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Clear logs
    if ((req.method === 'POST' || req.method === 'DELETE') && parsedUrl.pathname === '/api/logs') {
      try {
        const logFilePath = config.logPath;
        fs.writeFileSync(logFilePath, '', 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // [WAVE1-B] API: Export all listings as CSV (local download).
    if (req.method === 'GET' && parsedUrl.pathname === '/api/listings/export.csv') {
      try {
        const history = utils.readJsonFileSecure(config.historyPath, []);
        const csv = buildListingsCsv(history);
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="listai-pro-listings-${stamp}.csv"`
        });
        res.end(csv, 'utf8');
      } catch (err) {
        utils.logAudit("ERROR", `CSV export failed: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // [WAVE1-D] API: Import listings from CSV (mirror of export.csv).
    // Body: { csv: "<csv text>", dryRun?: boolean }. dryRun validates without writing.
    if (req.method === 'POST' && parsedUrl.pathname === '/api/listings/import') {
      let bodyData = '';
      req.on('data', chunk => { bodyData += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(bodyData);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }
          if (!payload || typeof payload.csv !== 'string' || payload.csv.trim() === '') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Payload must include a non-empty csv string." }));
            return;
          }
          // 10 MB cap keeps a hostile upload from exhausting memory.
          if (payload.csv.length > 10 * 1024 * 1024) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "CSV too large (max 10 MB)." }));
            return;
          }
          const result = importListingsFromCsv(payload.csv, { dryRun: !!payload.dryRun });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, dryRun: !!payload.dryRun, ...result }));
        } catch (err) {
          utils.logAudit("ERROR", `CSV import failed: ${err.message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // [WAVE1-B] API: Bulk mark listings sold / listed (or any allowed status).
    if (req.method === 'POST' && parsedUrl.pathname === '/api/listings/bulk-status') {
      let bodyData = '';
      req.on('data', chunk => { bodyData += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(bodyData);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }
          const skus = payload.skus;
          const status = payload.status;
          if (!Array.isArray(skus) || skus.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Payload must include a non-empty skus array." }));
            return;
          }
          const result = bulkUpdateListingStatus(skus.map(String), String(status));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, updated: result.updated, total: skus.length, results: result.results }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // [WAVE1-B] API: List background-task error notifications (unread = all queued).
    if (req.method === 'GET' && parsedUrl.pathname === '/api/notifications') {
      try {
        const notifications = utils.getNotifications();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ unread: notifications.length, notifications }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // [WAVE1-B] API: Dismiss a notification by id.
    if (req.method === 'POST' && parsedUrl.pathname === '/api/notifications/dismiss') {
      let bodyData = '';
      req.on('data', chunk => { bodyData += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(bodyData);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }
          if (!payload || !payload.id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Payload must include an id." }));
            return;
          }
          const dismissed = utils.dismissNotification(String(payload.id));
          if (!dismissed) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Notification not found." }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // API: Save configuration keys
    if (req.method === 'POST' && parsedUrl.pathname === '/api/config/save') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyData || '{}');
          if (typeof payload !== 'object' || payload === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload format" }));
            return;
          }

          // Validate key names to prevent malicious file injection
          const allowedKeys = [
            'API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
            'GOOGLE_REDIRECT_URI', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
            'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN', 'EBAY_LOCATION_KEY',
            'EBAY_FULFILLMENT_POLICY_ID', 'EBAY_PAYMENT_POLICY_ID', 'EBAY_RETURN_POLICY_ID',
            'SHOPIFY_SHOP_NAME', 'SHOPIFY_ACCESS_TOKEN',
            'WOOCOMMERCE_URL', 'WOOCOMMERCE_KEY', 'WOOCOMMERCE_SECRET',
            'ETSY_SHOP_ID', 'ETSY_ACCESS_TOKEN', 'ETSY_CLIENT_ID',
            'WATERMARK_TEXT', 'SKU_PREFIX', 'DEFAULT_PRICING_STRATEGY',
            'DEFAULT_SHIPPING_OPTION', 'DEFAULT_RETURN_OPTION', 'DEFAULT_IMMEDIATE_PAYMENT',
            'SELLER_SHIPPING_TERMS', 'SELLER_RETURN_TERMS'
          ];

          for (const key of Object.keys(payload)) {
            if (!allowedKeys.includes(key)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Unauthorized or invalid config key: ${key}` }));
              return;
            }
          }

          // Read current .env
          let envContent = '';
          if (fs.existsSync(config.envPath)) {
            envContent = fs.readFileSync(config.envPath, 'utf8');
          }

          let lines = envContent.split(/\r?\n/);

          // Update lines with payload keys
          for (const key of Object.keys(payload)) {
            const val = String(payload[key]).trim();
            process.env[key] = val; // update in-memory

            const index = lines.findIndex(l => {
              const trimmed = l.trim();
              return trimmed.startsWith(`${key}=`) || trimmed.startsWith(`#${key}=`);
            });

            if (index !== -1) {
              lines[index] = `${key}=${val}`;
            } else {
              lines.push(`${key}=${val}`);
            }
          }

          fs.writeFileSync(config.envPath, lines.join('\n'), 'utf8');
          utils.logAudit("INFO", `Updated config keys: ${Object.keys(payload).join(', ')}`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }


    // API: Sync Listings from eBay
    if (req.method === 'POST' && parsedUrl.pathname === '/api/sync') {
      try {
        await ebayClient.syncListingsFromEbay();
        await runInventoryCrossSync();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Serve local uploads statically (for image previews)
    if (req.method === 'GET' && parsedUrl.pathname.startsWith('/uploads/')) {
      const relativePath = parsedUrl.pathname.substring(9); // strip '/uploads/'
      const safePath = path.join(config.uploadTempDir, relativePath);
      try {
        const resolved = utils.safeResolvePath(safePath);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          const ext = path.extname(resolved).toLowerCase();
          let contentType = 'application/octet-stream';
          if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
          else if (ext === '.png') contentType = 'image/png';
          else if (ext === '.webp') contentType = 'image/webp';
          
          res.writeHead(200, { 'Content-Type': contentType });
          fs.createReadStream(resolved).pipe(res);
          return;
        }
      } catch (err) {
        utils.logAudit("WARN", `Failed to serve static upload: ${err.message}`);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end("404 Not Found");
      return;
    }

    // API: Import and spruce remote image URLs
    if (req.method === 'POST' && parsedUrl.pathname === '/api/images/import-urls') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(bodyData);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          const { urls, options: rawOptions = {} } = payload;
          if (!urls || !Array.isArray(urls) || urls.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: urls must be a non-empty array" }));
            return;
          }
          if (urls.length > utils.MAX_LISTING_IMAGES) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Too many URLs (max ${utils.MAX_LISTING_IMAGES})` }));
            return;
          }

          const options = sanitizeSpruceOptions(rawOptions);

          const validated = [];
          const rejected = [];
          for (const rawUrl of urls) {
            try {
              validated.push({ input: String(rawUrl).trim(), url: utils.validateRemoteImageUrl(String(rawUrl)) });
            } catch (err) {
              rejected.push({ input: String(rawUrl).slice(0, 200), error: err.message });
            }
          }

          if (validated.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: "No valid URLs to import",
              rejected
            }));
            return;
          }

          const imageDownloader = require('./lib/imageDownloader');
          const imagePipeline = require('./lib/imagePipeline');

          const responsePayload = [];
          for (const entry of validated) {
            try {
              const entryFiles = await imageDownloader.downloadUrlsConcurrently([entry.url], options);
              if (entryFiles.length === 0) {
                responsePayload.push({
                  success: false,
                  sourceUrl: entry.input,
                  error: 'No images could be downloaded from this URL'
                });
                continue;
              }

              for (const filepath of entryFiles) {
                try {
                  const result = await imagePipeline.processImageSource(filepath, options);
                  const localUrl = `/uploads/processed/${path.basename(result.outputPath)}`;
                  let uploadedUrl = null;
                  try {
                    uploadedUrl = await uploadImage(result.outputPath);
                  } catch (uploadErr) {
                    utils.logAudit("WARN", `External upload failed for imported image; local URL available: ${uploadErr.message}`);
                  }
                  responsePayload.push({
                    success: true,
                    sourceUrl: entry.input,
                    localUrl,
                    uploadedUrl,
                    metadata: result.metadata
                  });
                } catch (procErr) {
                  responsePayload.push({
                    success: false,
                    sourceUrl: entry.input,
                    error: procErr.message
                  });
                }
              }
            } catch (entryErr) {
              responsePayload.push({
                success: false,
                sourceUrl: entry.input,
                error: entryErr.message
              });
            }
          }

          rejected.forEach(r => {
            responsePayload.push({ success: false, sourceUrl: r.input, error: r.error });
          });

          const successCount = responsePayload.filter(r => r.success).length;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: successCount > 0,
            imported: successCount,
            failed: responsePayload.length - successCount,
            rejected,
            results: responsePayload
          }));
        } catch (e) {
          utils.logAudit("ERROR", `Import URLs failed: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Spruce image with custom options (crop, watermark, color Correction, bgRemove)
    if (req.method === 'POST' && parsedUrl.pathname === '/api/images/spruce') {
      let bodyData = '';
      req.on('data', chunk => bodyData += chunk);
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(bodyData);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          const { image, options: rawOptions = {} } = payload;
          if (!image || typeof image !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing required field: image" }));
            return;
          }

          const options = sanitizeSpruceOptions(rawOptions);
          let inputSource;
          let tempFilePath = null;
          
          if (image.startsWith('data:image')) {
            const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
            if (!base64Data) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Invalid base64 image payload" }));
              return;
            }
            const fileBuffer = Buffer.from(base64Data, 'base64');
            if (fileBuffer.length === 0 || fileBuffer.length > 12 * 1024 * 1024) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Image payload is empty or exceeds 12MB" }));
              return;
            }
            tempFilePath = path.join(config.uploadTempDir, `spruce-upload-${Date.now()}.jpg`);
            fs.writeFileSync(tempFilePath, fileBuffer);
            utils.verifyImageFile(tempFilePath);
            inputSource = tempFilePath;
          } else if (image.startsWith('/uploads/')) {
            inputSource = utils.resolveUploadsPath(image);
            if (!fs.existsSync(inputSource)) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Source image not found" }));
              return;
            }
            utils.verifyImageFile(inputSource);
          } else if (/^https?:\/\//i.test(image)) {
            utils.validateRemoteImageUrl(image);
            const imageDownloader = require('./lib/imageDownloader');
            inputSource = await imageDownloader.downloadAndCacheImage(image);
            tempFilePath = inputSource;
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Unsupported image reference format" }));
            return;
          }

          const imagePipeline = require('./lib/imagePipeline');
          const result = await imagePipeline.processImageSource(inputSource, options);
          const localUrl = `/uploads/processed/${path.basename(result.outputPath)}`;
          let uploadedUrl = null;
          try {
            uploadedUrl = await uploadImage(result.outputPath);
          } catch (uploadErr) {
            utils.logAudit("WARN", `External upload failed after spruce; local URL available: ${uploadErr.message}`);
          }

          if (tempFilePath && tempFilePath !== inputSource && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            localUrl,
            uploadedUrl,
            metadata: result.metadata
          }));
        } catch (e) {
          utils.logAudit("ERROR", `Spruce image failed: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Analyze product photos
    if (req.method === 'POST' && parsedUrl.pathname === '/api/analyze') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          // Validate payload schema
          if (typeof payload !== 'object' || payload === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: must be a JSON object" }));
            return;
          }
          if (!payload.images || !Array.isArray(payload.images) || payload.images.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing or empty images array" }));
            return;
          }
          if (payload.images.length > utils.MAX_LISTING_IMAGES) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Too many images (max ${utils.MAX_LISTING_IMAGES})` }));
            return;
          }
          if (payload.barcode !== undefined && payload.barcode !== null && typeof payload.barcode !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid barcode: must be a string" }));
            return;
          }
          if (payload.notes !== undefined && payload.notes !== null && typeof payload.notes !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid notes: must be a string" }));
            return;
          }
          if (payload.persona !== undefined && payload.persona !== null && typeof payload.persona !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid persona: must be a string" }));
            return;
          }
          if (payload.template !== undefined && payload.template !== null && typeof payload.template !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid template: must be a string" }));
            return;
          }

          await ebayClient.refreshEbayAccessToken();

          let upcData = null;
          if (payload.barcode) {
            // [WAVE1-C] Extended barcode enrichment: ISBN -> Google Books,
            // music -> Discogs/MusicBrainz, degrades to the eBay catalog path.
            upcData = await resolveBarcodeData(payload.barcode);
          }

          const fileBuffers = [];
          const tempPaths = [];

          for (let i = 0; i < payload.images.length; i++) {
            let materialized;
            try {
              materialized = await materializeImageReference(payload.images[i], i);
            } catch (imgErr) {
              tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: imgErr.message }));
              return;
            }

            fileBuffers.push(materialized.fileBuffer);
            tempPaths.push(...materialized.tempPaths);
          }

          const listing = await geminiClient.runAIOrchestration(
            fileBuffers, 
            tempPaths.map(p => path.basename(p)), 
            payload.barcode, 
            payload.notes, 
            upcData,
            { persona: payload.persona, template: payload.template }
          );
          const categorySuggestions = await ebayClient.getCategorySuggestions(listing.title);
          const imageUrls = await uploadImagesConcurrently(tempPaths, 2);

          tempPaths.forEach(p => {
            try { fs.unlinkSync(p); } catch (e) {}
          });

          let stockPhotos = [];
          if (upcData && Array.isArray(upcData.stockImageUrls)) {
            stockPhotos = upcData.stockImageUrls;
          }
          if (stockPhotos.length === 0) {
            stockPhotos = await ebayClient.searchCatalogStockPhotos(listing.title);
          }

          const comps = listing.compsPriceInfo || await ebayClient.searchEbayComps(listing.title, listing.condition);
          if (listing.compsPriceInfo) {
            delete listing.compsPriceInfo; // Clean it up before responding
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ listing, imageUrls, categorySuggestions, comps, stockPhotos }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // [WAVE1-C] API: Enhance a seller-written title/description with AI polish.
    // Distinct from the photo->listing generation flow (/api/analyze).
    if (req.method === 'POST' && parsedUrl.pathname === '/api/enhance') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          // Validate payload schema
          if (typeof payload !== 'object' || payload === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: must be a JSON object" }));
            return;
          }
          if (typeof payload.title !== 'string' || typeof payload.description !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: title and description must be strings" }));
            return;
          }
          if (payload.context !== undefined && payload.context !== null && typeof payload.context !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid context: must be a string" }));
            return;
          }

          const enhanced = await geminiClient.enhanceListingDraft({
            title: payload.title,
            description: payload.description,
            context: payload.context || null
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(enhanced));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Publish listing to eBay (and optional Shopify cross-post)
    if (req.method === 'POST' && parsedUrl.pathname === '/api/publish') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          // Validate publish schema
          if (typeof payload !== 'object' || payload === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: must be a JSON object" }));
            return;
          }

          const finalListing = payload.listing;
          const imageUrls = payload.imageUrls;

          if (!finalListing || typeof finalListing !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing or invalid listing object" }));
            return;
          }
          if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing or empty imageUrls array" }));
            return;
          }
          for (const url of imageUrls) {
            if (typeof url !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: "Invalid imageUrls element: must be a string URL" }));
              return;
            }
          }

          // Convert all image URLs to native EPS URLs (permanent)
          const finalImageUrls = [];
          for (const url of imageUrls) {
            const epsUrl = await convertImageToEPS(url);
            finalImageUrls.push(epsUrl);
          }

          // Sanitize listing object to conform to invariants
          geminiClient.validateAndFixListingSchema(finalListing);

          // 1. Deduplication Gatekeeper Check
          if (payload.force !== true) {
            const history = utils.readJsonFileSecure(config.historyPath, []);
            const isDuplicate = history.some(item => {
              if (item.status !== "ACTIVE" && item.status !== "DRAFT") return false;
              const ageMs = Date.now() - new Date(item.timestamp).getTime();
              if (ageMs > 60 * 60 * 1000) return false;
              const titleMatch = item.title && finalListing.title &&
                (item.title.toLowerCase().replace(/[^a-z0-9]/g, '') === finalListing.title.toLowerCase().replace(/[^a-z0-9]/g, ''));
              const upcMatch = item.listingDetails?.upc && finalListing.upc &&
                item.listingDetails.upc !== "Does Not Apply" && item.listingDetails.upc === finalListing.upc;
              return titleMatch || upcMatch;
            });

            if (isDuplicate) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: "DUPLICATE_LISTING",
                message: `A listing with a very similar title ("${finalListing.title}") was published or created in the last 60 minutes.`
              }));
              return;
            }
          }

          // 2. VeRO Brand Gatekeeper Check for publishing
          if (payload.force !== true && finalListing.brand) {
            const normalizedBrand = finalListing.brand.trim().toLowerCase();
            const veroBrands = config.getVERO_BRANDS();
            if (veroBrands.includes(normalizedBrand)) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: "VERO_BRAND_BLOCKED",
                message: `Brand "${finalListing.brand}" is registered under eBay's VeRO protection list. Publishing blocked to prevent policy violations.`
              }));
              return;
            }
          }

          if (finalListing.description) {
            finalListing.description = utils.stripScriptsAndIframes(finalListing.description);
          }

          await ebayClient.refreshEbayAccessToken();
          
          const policies = await ebayClient.getOrCreateListingPolicies(
            payload.shippingOption || "USPS_GROUND",
            payload.returnOption || "NO_RETURNS",
            payload.immediatePayment !== false,
            payload.shippingType || "CALCULATED"
          );

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

          const sku = payload.sku || `${config.getSKU_PREFIX()}SKU-${Date.now()}`;
          const finalQty = parseInt(payload.quantity || finalListing.quantity || 1, 10) || 1;

          // [WAVE1-A] All marketplace-bound payloads build from a sanitized copy:
          // private fields (internalNotes, costOfGoods) never leave this server.
          const outboundListing = utils.sanitizeListingForMarketplace(finalListing);
          // [WAVE1-A] Thread MSRP into the buyer-facing description footer.
          if (finalListing.msrp && !(outboundListing.description || '').includes("Original MSRP")) {
            outboundListing.description += `\n<p><strong>Original MSRP:</strong> $${Number(finalListing.msrp).toFixed(2)}</p>`;
          }

          let inventoryItem = {
            condition: outboundListing.condition,
            availability: { shipToLocationAvailability: { quantity: finalQty } },
            product: {
              title: outboundListing.title.slice(0, 80),
              description: outboundListing.description,
              brand: outboundListing.brand,
              mpn: outboundListing.model || "Does Not Apply",
              aspects: Object.fromEntries(Object.entries(outboundListing.aspects).map(([k, v]) => [k, [v]])),
              imageUrls: finalImageUrls
            },
            packageWeightAndSize: {
              dimensions: {
                unit: "INCH",
                length: outboundListing.packageLength,
                width: outboundListing.packageWidth,
                height: outboundListing.packageHeight
              },
              packageType: "PACKAGE",
              weight: {
                unit: "OUNCE",
                value: (outboundListing.weightMajor * 16) + outboundListing.weightMinor
              }
            }
          };

          inventoryItem = ebayClient.sanitizeAndOptimizeInventoryItem(inventoryItem);
          inventoryItem = ebayClient.genericizeVeroBrandListing(inventoryItem, payload.genericizeVero === true);
          await ebayClient.enrichRequiredAspects(inventoryItem, finalListing.categoryId);

          await ebayClient.ebayRequest(`/inventory_item/${encodeURIComponent(sku)}`, "PUT", inventoryItem);

          const offerPayload = {
            sku: sku,
            marketplaceId: "EBAY_US",
            format: "FIXED_PRICE",
            availableQuantity: finalQty,
            includeCatalogProductDetails: true,
            merchantLocationKey: config.getEBAY_LOCATION_KEY(),
            categoryId: outboundListing.categoryId,
            listingDescription: outboundListing.description,
            listingDuration: "GTC",
            listingPolicies: {
              fulfillmentPolicyId: policies.fulfillmentId,
              paymentPolicyId: policies.paymentId,
              returnPolicyId: policies.returnId
            },
            pricingSummary: {
              price: { currency: "USD", value: String(outboundListing.suggestedPrice) }
            }
          };

          if (payload.bestOfferEnabled) {
            offerPayload.bestOfferTerms = {
              bestOfferEnabled: true
            };
            if (payload.autoAcceptPrice && parseFloat(payload.autoAcceptPrice) > 0) {
              offerPayload.bestOfferTerms.autoAcceptPrice = {
                value: String(parseFloat(payload.autoAcceptPrice).toFixed(2)),
                currency: "USD"
              };
            }
            if (payload.autoDeclinePrice && parseFloat(payload.autoDeclinePrice) > 0) {
              offerPayload.bestOfferTerms.autoDeclinePrice = {
                value: String(parseFloat(payload.autoDeclinePrice).toFixed(2)),
                currency: "USD"
              };
            }
          }

          const offerResponse = await ebayClient.ebayRequest("/offer", "POST", offerPayload);
          const publishResponse = await ebayClient.ebayRequest(`/offer/${offerResponse.offerId}/publish`, "POST");

          if (payload.promoteEnabled && publishResponse.listingId) {
            // Run asynchronously to not block response
            ebayClient.promoteListingStandard(publishResponse.listingId, sku, payload.bidPercentage || 2.0);
          }

          // Concurrent server-side cross-posting to Shopify, WooCommerce, and Etsy
          const crossPostPromises = [];
          const crossPostKeys = [];

          if (payload.crossPostShopify && config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()) {
            crossPostPromises.push(crossPostToShopify(outboundListing, finalImageUrls, sku));
            crossPostKeys.push('shopify');
          }
          if (payload.crossPostWooCommerce && config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()) {
            crossPostPromises.push(crossPost.crossPostToWooCommerce(outboundListing, finalImageUrls, sku));
            crossPostKeys.push('woocommerce');
          }
          if (payload.crossPostEtsy && config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN()) {
            crossPostPromises.push(crossPost.crossPostToEtsy(outboundListing, sku));
            crossPostKeys.push('etsy');
          }

          const crossPostResults = {};
          let shopifyId = null;
          let woocommerceId = null;
          let etsyId = null;

          if (crossPostPromises.length > 0) {
            const results = await Promise.allSettled(crossPostPromises);
            results.forEach((resVal, idx) => {
              const platform = crossPostKeys[idx];
              if (resVal.status === 'fulfilled' && resVal.value) {
                crossPostResults[platform] = { success: true, id: resVal.value };
                if (platform === 'shopify') shopifyId = String(resVal.value);
                else if (platform === 'woocommerce') woocommerceId = String(resVal.value);
                else if (platform === 'etsy') etsyId = String(resVal.value);
              } else {
                const errMsg = resVal.reason?.message || "Unknown error";
                crossPostResults[platform] = { success: false, error: errMsg };
                utils.logAudit("ERROR", `${platform} concurrent cross-posting failed: ${errMsg}`);
              }
            });
          }

          utils.saveListingToHistory(
            sku,
            publishResponse.listingId,
            finalListing.title,
            finalListing.suggestedPrice,
            finalListing.categoryId,
            offerResponse.offerId,
            shopifyId,
            "ACTIVE",
            null,
            woocommerceId,
            etsyId
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            listingId: publishResponse.listingId,
            shopifyId,
            woocommerceId,
            etsyId,
            crossPostResults
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Save draft listing
    if (req.method === 'POST' && parsedUrl.pathname === '/api/save-draft') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          if (typeof payload !== 'object' || payload === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: must be a JSON object" }));
            return;
          }

          const finalListing = payload.listing;
          const imageUrls = payload.imageUrls;

          if (!finalListing || typeof finalListing !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Missing or invalid listing object" }));
            return;
          }

          geminiClient.validateAndFixListingSchema(finalListing);

          // [WAVE1-A] Normalize Wave 1A fields (keywords/msrp/costOfGoods/internalNotes)
          // so listingDetails always carries a stable shape.
          utils.normalizeListingFields(finalListing);
          if (finalListing.description) {
            finalListing.description = utils.stripScriptsAndIframes(finalListing.description);
          }

          // [merge] No duplicate gate on save-draft: the Wave-verified draft flow
          // (batch imports, multiple units sharing a UPC) saves drafts freely.
          // Duplicate protection stays on /api/publish and /api/publish-draft,
          // where Master's tests exercise the 409 + force-override behavior.

          // Auto-Enriched UPC Sourcing from active comps if missing
          if (!finalListing.upc || finalListing.upc === "" || finalListing.upc === "Does Not Apply") {
            try {
              const compUpc = await ebayClient.findUpcFromComps(finalListing.title);
              if (compUpc) {
                finalListing.upc = compUpc;
              }
            } catch (e) {
              utils.logAudit("WARN", `Failed to auto-enrich UPC: ${e.message}`);
            }
          }

          // VeRO Brand Gatekeeper validation check
          let veroWarning = false;
          if (finalListing.brand) {
            const normalizedBrand = finalListing.brand.trim().toLowerCase();
            const veroBrands = config.getVERO_BRANDS();
            if (veroBrands.includes(normalizedBrand)) {
              veroWarning = true;
            }
          }
          finalListing.veroWarning = veroWarning;

          let sku = payload.sku;
          if (!sku) {
            const skuPrefix = config.getSKU_PREFIX();
            sku = `${skuPrefix}SKU-${Date.now()}`;
          }

          // Establish persistent listing image directory under data/uploads/listings/<SKU>/
          const skuClean = sku.replace(/[^a-zA-Z0-9-]/g, '_');
          const persistentDir = path.join(config.uploadTempDir, 'listings', skuClean);
          if (!fs.existsSync(persistentDir)) {
            fs.mkdirSync(persistentDir, { recursive: true });
          }

          // Download and optimize external/stock images, moving local ones to persistent directory
          const finalImageUrls = [];
          if (imageUrls && Array.isArray(imageUrls)) {
            for (const url of imageUrls) {
              if (url.startsWith('http') && !url.includes('tmpfiles.org') && !url.includes('file.io')) {
                const optUrl = await downloadAndOptimizeStockPhoto(url);
                finalImageUrls.push(optUrl);
              } else if (url.includes('/uploads/')) {
                const filename = path.basename(url);
                let sourcePath = path.join(config.uploadTempDir, 'processed', filename);
                if (!fs.existsSync(sourcePath)) {
                  sourcePath = path.join(config.uploadTempDir, filename);
                }
                
                if (fs.existsSync(sourcePath)) {
                  const targetPath = path.join(persistentDir, filename);
                  fs.copyFileSync(sourcePath, targetPath);
                  finalImageUrls.push(`/uploads/listings/${skuClean}/${filename}`);
                } else {
                  finalImageUrls.push(url);
                }
              } else {
                finalImageUrls.push(url);
              }
            }
          }

          const listingDetails = {
            ...finalListing,
            imageUrls: finalImageUrls
          };

          const history = utils.readJsonFileSecure(config.historyPath, []);
          const existingIndex = history.findIndex(item => item.sku === sku);

          if (existingIndex !== -1) {
            // Update existing draft
            history[existingIndex].timestamp = new Date().toISOString();
            history[existingIndex].title = finalListing.title;
            history[existingIndex].price = parseFloat(finalListing.suggestedPrice);
            history[existingIndex].categoryId = finalListing.categoryId;
            history[existingIndex].brand = finalListing.brand || "Generic";
            history[existingIndex].veroWarning = veroWarning;
            history[existingIndex].listingDetails = listingDetails;
            utils.writeJsonFileSecure(config.historyPath, history);
            utils.logAudit("INFO", `Updated existing draft. SKU: ${sku}`);
          } else {
            // Create new draft
            utils.saveListingToHistory(sku, null, finalListing.title, finalListing.suggestedPrice, finalListing.categoryId, null, null, "DRAFT", listingDetails);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, sku, veroWarning, upc: finalListing.upc }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: Publish draft listing
    if (req.method === 'POST' && parsedUrl.pathname === '/api/publish-draft') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          if (typeof payload !== 'object' || payload === null || !payload.sku || typeof payload.sku !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: Missing SKU field" }));
            return;
          }

          const history = utils.readJsonFileSecure(config.historyPath, []);
          const index = history.findIndex(item => item.sku === payload.sku);
          if (index === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Draft not found with specified SKU" }));
            return;
          }

          const item = history[index];
          if (item.status !== "DRAFT" || !item.listingDetails) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Item is not a valid draft listing" }));
            return;
          }

          const finalListing = item.listingDetails;
          
          // 1. Deduplication Gatekeeper Check
          if (payload.force !== true) {
            const isDuplicate = history.some(item => {
              if (item.status !== "ACTIVE") return false;
              const ageMs = Date.now() - new Date(item.timestamp).getTime();
              if (ageMs > 60 * 60 * 1000) return false;
              const titleMatch = item.title && finalListing.title &&
                (item.title.toLowerCase().replace(/[^a-z0-9]/g, '') === finalListing.title.toLowerCase().replace(/[^a-z0-9]/g, ''));
              const upcMatch = item.listingDetails?.upc && finalListing.upc &&
                item.listingDetails.upc !== "Does Not Apply" && item.listingDetails.upc === finalListing.upc;
              return titleMatch || upcMatch;
            });

            if (isDuplicate) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: "DUPLICATE_LISTING",
                message: `A listing with a very similar title ("${finalListing.title}") was published in the last 60 minutes.`
              }));
              return;
            }
          }

          // 2. VeRO Brand Gatekeeper Check
          if (payload.force !== true && finalListing.brand) {
            const normalizedBrand = finalListing.brand.trim().toLowerCase();
            const veroBrands = config.getVERO_BRANDS();
            if (veroBrands.includes(normalizedBrand)) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: "VERO_BRAND_BLOCKED",
                message: `Brand "${finalListing.brand}" is registered under eBay's VeRO protection list. Publishing blocked.`
              }));
              return;
            }
          }

          if (finalListing.description) {
            finalListing.description = utils.stripScriptsAndIframes(finalListing.description);
          }

          const imageUrls = finalListing.imageUrls || [];

          // Convert all image URLs to native EPS URLs (permanent)
          const finalImageUrls = [];
          for (const url of imageUrls) {
            const epsUrl = await convertImageToEPS(url);
            finalImageUrls.push(epsUrl);
          }
          finalListing.imageUrls = finalImageUrls;

          // Format description terms if they are not already there
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

          // [WAVE1-A] All marketplace-bound payloads build from a sanitized copy:
          // private fields (internalNotes, costOfGoods) never leave this server.
          const outboundListing = utils.sanitizeListingForMarketplace(finalListing);
          // [WAVE1-A] Thread MSRP into the buyer-facing description footer.
          if (finalListing.msrp && !(outboundListing.description || '').includes("Original MSRP")) {
            outboundListing.description += `\n<p><strong>Original MSRP:</strong> $${Number(finalListing.msrp).toFixed(2)}</p>`;
          }

          await ebayClient.refreshEbayAccessToken();
          
          const policies = await ebayClient.getOrCreateListingPolicies(
            payload.shippingOption || "USPS_GROUND",
            payload.returnOption || "NO_RETURNS",
            payload.immediatePayment !== false,
            payload.shippingType || "CALCULATED"
          );

          const finalQty = parseInt(payload.quantity || finalListing.quantity || 1, 10) || 1;

          let inventoryItem = {
            condition: outboundListing.condition,
            availability: { shipToLocationAvailability: { quantity: finalQty } },
            product: {
              title: outboundListing.title.slice(0, 80),
              description: outboundListing.description,
              brand: outboundListing.brand,
              mpn: outboundListing.model || "Does Not Apply",
              aspects: Object.fromEntries(Object.entries(outboundListing.aspects || {}).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])),
              imageUrls: finalImageUrls
            },
            packageWeightAndSize: {
              dimensions: {
                unit: "INCH",
                length: outboundListing.packageLength,
                width: outboundListing.packageWidth,
                height: outboundListing.packageHeight
              },
              packageType: "PACKAGE",
              weight: {
                unit: "OUNCE",
                value: (outboundListing.weightMajor * 16) + outboundListing.weightMinor
              }
            }
          };

          inventoryItem = ebayClient.sanitizeAndOptimizeInventoryItem(inventoryItem);
          inventoryItem = ebayClient.genericizeVeroBrandListing(inventoryItem, payload.genericizeVero === true);
          await ebayClient.enrichRequiredAspects(inventoryItem, finalListing.categoryId);

          await ebayClient.ebayRequest(`/inventory_item/${encodeURIComponent(payload.sku)}`, "PUT", inventoryItem);

          const offerPayload = {
            sku: payload.sku,
            marketplaceId: "EBAY_US",
            format: "FIXED_PRICE",
            availableQuantity: finalQty,
            includeCatalogProductDetails: true,
            merchantLocationKey: config.getEBAY_LOCATION_KEY(),
            categoryId: outboundListing.categoryId,
            listingDescription: outboundListing.description,
            listingDuration: "GTC",
            listingPolicies: {
              fulfillmentPolicyId: policies.fulfillmentId,
              paymentPolicyId: policies.paymentId,
              returnPolicyId: policies.returnId
            },
            pricingSummary: {
              price: { currency: "USD", value: String(outboundListing.suggestedPrice) }
            }
          };

          if (payload.bestOfferEnabled) {
            offerPayload.bestOfferTerms = {
              bestOfferEnabled: true
            };
            if (payload.autoAcceptPrice && parseFloat(payload.autoAcceptPrice) > 0) {
              offerPayload.bestOfferTerms.autoAcceptPrice = {
                value: String(parseFloat(payload.autoAcceptPrice).toFixed(2)),
                currency: "USD"
              };
            }
            if (payload.autoDeclinePrice && parseFloat(payload.autoDeclinePrice) > 0) {
              offerPayload.bestOfferTerms.autoDeclinePrice = {
                value: String(parseFloat(payload.autoDeclinePrice).toFixed(2)),
                currency: "USD"
              };
            }
          }

          const offerResponse = await ebayClient.ebayRequest("/offer", "POST", offerPayload);
          const publishResponse = await ebayClient.ebayRequest(`/offer/${offerResponse.offerId}/publish`, "POST");

          if (payload.promoteEnabled && publishResponse.listingId) {
            // Run asynchronously to not block response
            ebayClient.promoteListingStandard(publishResponse.listingId, payload.sku, payload.bidPercentage || 2.0);
          }

          // Concurrent server-side cross-posting to Shopify, WooCommerce, and Etsy
          const crossPostPromises = [];
          const crossPostKeys = [];

          if (payload.crossPostShopify && config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()) {
            crossPostPromises.push(crossPostToShopify(outboundListing, finalImageUrls, payload.sku));
            crossPostKeys.push('shopify');
          }
          if (payload.crossPostWooCommerce && config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()) {
            crossPostPromises.push(crossPost.crossPostToWooCommerce(outboundListing, finalImageUrls, payload.sku));
            crossPostKeys.push('woocommerce');
          }
          if (payload.crossPostEtsy && config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN()) {
            crossPostPromises.push(crossPost.crossPostToEtsy(outboundListing, payload.sku));
            crossPostKeys.push('etsy');
          }

          const crossPostResults = {};
          let shopifyId = null;
          let woocommerceId = null;
          let etsyId = null;

          if (crossPostPromises.length > 0) {
            const results = await Promise.allSettled(crossPostPromises);
            results.forEach((resVal, idx) => {
              const platform = crossPostKeys[idx];
              if (resVal.status === 'fulfilled' && resVal.value) {
                crossPostResults[platform] = { success: true, id: resVal.value };
                if (platform === 'shopify') shopifyId = String(resVal.value);
                else if (platform === 'woocommerce') woocommerceId = String(resVal.value);
                else if (platform === 'etsy') etsyId = String(resVal.value);
              } else {
                const errMsg = resVal.reason?.message || "Unknown error";
                crossPostResults[platform] = { success: false, error: errMsg };
                utils.logAudit("ERROR", `${platform} concurrent draft cross-posting failed: ${errMsg}`);
              }
            });
          }

          // Update entry in history
          item.listingId = publishResponse.listingId;
          item.offerId = offerResponse.offerId;
          item.shopifyId = shopifyId || item.shopifyId || null;
          item.woocommerceId = woocommerceId || item.woocommerceId || null;
          item.etsyId = etsyId || item.etsyId || null;
          item.status = "ACTIVE";
          
          utils.writeJsonFileSecure(config.historyPath, history);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            listingId: publishResponse.listingId,
            shopifyId,
            woocommerceId,
            etsyId,
            crossPostResults
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API: End live listing
    if (req.method === 'POST' && parsedUrl.pathname === '/api/end-listing') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Malformed JSON payload" }));
            return;
          }

          if (typeof payload !== 'object' || payload === null || !payload.sku || typeof payload.sku !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Invalid payload: Missing SKU field" }));
            return;
          }
          await ebayClient.refreshEbayAccessToken();
          const listingId = await ebayClient.endListingOnEbay(payload.sku, payload.offerId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, listingId }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end("404 Not Found");
      } catch (err) {
        utils.logAudit("ERROR", `Unhandled request error: ${err.message}`, { stack: err.stack });
        sendError(res, err);
      }
    });
  });

  // Track active connections for graceful shutdown
  server.on('connection', socket => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  let isShuttingDown = false;
  const gracefulShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    utils.logAudit("INFO", `Shutting down web GUI server gracefully... Active requests: ${activeRequests}`);
    
    server.close(() => {
      utils.logAudit("INFO", "Web server closed.");
      process.exit(0);
    });

    if (activeRequests === 0) {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      process.exit(0);
    }

    const forceShutdownTimeout = setTimeout(() => {
      utils.logAudit("WARN", `Graceful shutdown timeout reached. Force destroying ${activeSockets.size} remaining sockets...`);
      for (const socket of activeSockets) {
        socket.destroy();
      }
      process.exit(0);
    }, 5000);
    if (forceShutdownTimeout && typeof forceShutdownTimeout.unref === 'function') {
      forceShutdownTimeout.unref();
    }
  };

  if (!shutdownRegistered) {
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    shutdownRegistered = true;
  }

  // Strictly bind only to localhost loopback '127.0.0.1' for security
  server.listen(port, '127.0.0.1', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 eBay Personal Lister GUI server started!`);
    console.log(`🔗 Access Dashboard: http://127.0.0.1:${port}`);
    console.log(`======================================================\n`);
    
    // Clean old files on startup
    utils.cleanOldTempFiles();
    
    // [WAVE1-B] Background task runner: each task gets its own try/catch so one
    // failure does not abort the others, and failures surface as user-visible notifications.
    async function runBackgroundTask(task, fn) {
      try {
        await fn();
      } catch (err) {
        utils.logAudit("ERROR", `Background task [${task}] failed: ${err.message}`);
        utils.appendNotification(task, err.message);
      }
    }

    // Start automated background inventory cross-sync check every 5 minutes
    const syncInterval = setInterval(async () => {
      await runBackgroundTask("ebay-sync", () => ebayClient.syncListingsFromEbay());
      await runBackgroundTask("inventory-cross-sync", () => runInventoryCrossSync());
      await runBackgroundTask("dlq-processing", () => crossPost.processPendingSyncsDlq());
      try {
        utils.cleanOldTempFiles();
      } catch (err) {
        utils.logAudit("ERROR", `Background temp cleanup failed: ${err.message}`);
      }
    }, 5 * 60 * 1000);
    if (syncInterval && typeof syncInterval.unref === 'function') {
      syncInterval.unref();
    }

    // Run once on startup asynchronously
    runInventoryCrossSync().catch(err => {
      utils.logAudit("ERROR", `Initial startup inventory sync failed: ${err.message}`);
      utils.appendNotification("inventory-cross-sync", `Startup sync failed: ${err.message}`); // [WAVE1-B]
    });
    crossPost.processPendingSyncsDlq().catch(err => {
      utils.logAudit("ERROR", `Initial startup DLQ processing failed: ${err.message}`);
      utils.appendNotification("dlq-processing", `Startup DLQ processing failed: ${err.message}`); // [WAVE1-B]
    });

    const command = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    exec(`${command} http://127.0.0.1:${port}`);
  });

  return server;
}

const SPRUCE_BG_STYLES = new Set(['white', 'gradient', 'transparent']);
const SPRUCE_WATERMARK_POSITIONS = new Set([
  'bottom-right', 'bottom-left', 'top-right', 'top-left', 'diagonal', 'diagonal-tile'
]);

/**
 * Sanitizes spruce/image pipeline options from client payloads.
 * @param {object} raw
 * @returns {object}
 */
function sanitizeSpruceOptions(raw = {}) {
  const opts = {};
  if (typeof raw.watermarkText === 'string') {
    opts.watermarkText = raw.watermarkText.trim().slice(0, 120);
  }
  if (typeof raw.watermarkPosition === 'string' && SPRUCE_WATERMARK_POSITIONS.has(raw.watermarkPosition)) {
    opts.watermarkPosition = raw.watermarkPosition;
  }
  if (typeof raw.bgStyle === 'string' && SPRUCE_BG_STYLES.has(raw.bgStyle)) {
    opts.bgStyle = raw.bgStyle;
  }
  if (typeof raw.colorCorrection === 'boolean') opts.colorCorrection = raw.colorCorrection;
  if (typeof raw.bgRemove === 'boolean') opts.bgRemove = raw.bgRemove;
  if (typeof raw.watermark === 'boolean') opts.watermark = raw.watermark;

  const rotate = parseInt(raw.rotate, 10);
  if ([0, 90, 180, 270].includes(rotate)) opts.rotate = rotate;

  const canvasSize = parseInt(raw.canvasSize, 10);
  if ([800, 1200, 1600].includes(canvasSize)) opts.canvasSize = canvasSize;

  const brightness = parseFloat(raw.brightness);
  if (!Number.isNaN(brightness)) opts.brightness = Math.min(1.5, Math.max(0.5, brightness));

  const saturation = parseFloat(raw.saturation);
  if (!Number.isNaN(saturation)) opts.saturation = Math.min(1.5, Math.max(0.5, saturation));

  if (raw.crop && typeof raw.crop === 'object') {
    const x = Number(raw.crop.x);
    const y = Number(raw.crop.y);
    const w = Number(raw.crop.w);
    const h = Number(raw.crop.h);
    if ([x, y, w, h].every(v => Number.isFinite(v)) && w > 0 && h > 0) {
      opts.crop = {
        x: Math.min(0.99, Math.max(0, x)),
        y: Math.min(0.99, Math.max(0, y)),
        w: Math.min(1, Math.max(0.01, w)),
        h: Math.min(1, Math.max(0.01, h))
      };
    }
  }

  return opts;
}

/**
 * Materializes an image reference (base64, /uploads/ path, or remote URL) into a verified temp file.
 * @param {string} imageRef
 * @param {number} index
 * @returns {Promise<{fileBuffer: Buffer, tempPaths: string[]}>}
 */
async function materializeImageReference(imageRef, index) {
  if (typeof imageRef !== 'string' || !imageRef.trim()) {
    throw new Error(`Image ${index + 1}: empty or invalid reference`);
  }

  const tempPaths = [];
  let workingPath;

  if (imageRef.startsWith('data:image')) {
    const base64Data = imageRef.replace(/^data:image\/\w+;base64,/, "");
    if (!base64Data) {
      throw new Error(`Image ${index + 1}: invalid base64 payload`);
    }
    const fileBuffer = Buffer.from(base64Data, 'base64');
    if (fileBuffer.length === 0) {
      throw new Error(`Image ${index + 1}: decoded image is empty`);
    }
    if (fileBuffer.length > 12 * 1024 * 1024) {
      throw new Error(`Image ${index + 1}: exceeds 12MB limit`);
    }

    workingPath = path.join(config.uploadTempDir, `web-upload-${Date.now()}-${index}.jpg`);
    fs.writeFileSync(workingPath, fileBuffer);
    tempPaths.push(workingPath);
  } else if (imageRef.startsWith('/uploads/')) {
    workingPath = utils.resolveUploadsPath(imageRef);
    if (!fs.existsSync(workingPath)) {
      throw new Error(`Image ${index + 1}: local file not found`);
    }
    utils.verifyImageFile(workingPath);
  } else if (/^https?:\/\//i.test(imageRef)) {
    utils.validateRemoteImageUrl(imageRef);
    const imageDownloader = require('./lib/imageDownloader');
    workingPath = await imageDownloader.downloadAndCacheImage(imageRef);
    tempPaths.push(workingPath);
  } else {
    throw new Error(`Image ${index + 1}: unsupported format (use upload, import, or data URL)`);
  }

  try {
    utils.verifyImageFile(workingPath);
  } catch (imgErr) {
    tempPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    throw new Error(`Image ${index + 1}: ${imgErr.message}`);
  }

  const optimizedFilename = `opt-web-upload-${Date.now()}-${index}.jpg`;
  const optimizedFilePath = path.join(config.uploadTempDir, optimizedFilename);

  try {
    await utils.optimizeImageNative(workingPath, optimizedFilePath, 1600);
    if (tempPaths.includes(workingPath)) {
      try { fs.unlinkSync(workingPath); } catch (e) {}
    }
    tempPaths.push(optimizedFilePath);
    return { fileBuffer: fs.readFileSync(optimizedFilePath), tempPaths };
  } catch (optErr) {
    utils.logAudit("WARN", `Failed to optimize image ${path.basename(workingPath)}: ${optErr.message}`);
    if (!tempPaths.includes(workingPath)) tempPaths.push(workingPath);
    return { fileBuffer: fs.readFileSync(workingPath), tempPaths };
  }
}

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
function resetRateLimits() {
  rateLimits.clear();
  analyzeRateLimits.clear();
}

module.exports = {
  startWebGuiServer,
  crossPostToShopify,
  resetRateLimits,
  // [WAVE1-B] Wave-1 bulk/notifications helpers (exported for tests)
  csvEscape,
  buildListingsCsv,
  bulkUpdateListingStatus,
  BULK_ALLOWED_STATUSES,
  // [WAVE1-C] Exported for unit tests
  isIsbn13,
  resolveBarcodeData,
  // [WAVE1-D] Exported for unit tests
  LISTING_CSV_HEADERS,
  parseListingsCsv,
  validateImportRow,
  importListingsFromCsv,
  TEAM_SEATS_BY_PLAN,
  getTeamMaxSeats,
  getBillingPlan,
  readTeamStore,
  countUsedSeats,
  inviteTeamMember,
  removeTeamMember,
  acceptTeamInvite,
  leaveTeam,
  getWorkspaceFor
};

if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 45900;
  startWebGuiServer(port);
}
