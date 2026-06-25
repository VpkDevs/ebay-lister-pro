/**
 * @file ebayClient.js
 * @description Interfaces with the eBay Sell Inventory, Account, and Commerce Taxonomy REST endpoints.
 * Handles OAuth, business policy provisions, category suggestions, and live portfolo synchronization.
 */

class OAuthRefreshError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuthRefreshError';
  }
}

const config = require('./config');
const utils = require('./utils');

let ebayAccessToken = process.env.EBAY_USER_TOKEN || null;

const circuitBreakers = new Map();

/**
 * Parses URL to extract hostname.
 * @param {string} url - Target URL.
 * @returns {string} hostname.
 */
function getDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch (e) {
    return 'unknown';
  }
}

/**
 * Gets or initializes a circuit breaker for a domain.
 * @param {string} domain - Domain name.
 * @returns {object} Breaker state.
 */
function getCircuitBreaker(domain) {
  if (!circuitBreakers.has(domain)) {
    circuitBreakers.set(domain, { consecutiveFailures: 0, brokenUntil: 0, state: 'CLOSED' });
  }
  return circuitBreakers.get(domain);
}

/**
 * Updates a circuit breaker's state based on success/failure.
 * @param {string} domain - Domain name.
 * @param {string} event - SUCCESS or FAILURE.
 */
function updateBreakerState(domain, event) {
  const cb = getCircuitBreaker(domain);
  const now = Date.now();
  const oldState = cb.state;
  
  if (cb.brokenUntil > 0 && now >= cb.brokenUntil && cb.state === 'OPEN') {
    cb.state = 'HALF-OPEN';
  }
  
  if (event === 'SUCCESS') {
    cb.consecutiveFailures = 0;
    cb.brokenUntil = 0;
    cb.state = 'CLOSED';
  } else if (event === 'FAILURE') {
    cb.consecutiveFailures++;
    if (cb.consecutiveFailures >= 5) {
      cb.brokenUntil = now + 30000;
      cb.state = 'OPEN';
    }
  }
  
  if (cb.state !== oldState) {
    utils.logAudit("INFO", `Circuit Breaker State Transition for ${domain}: ${oldState} -> ${cb.state}`, {
      consecutiveFailures: cb.consecutiveFailures,
      brokenUntil: cb.brokenUntil
    });
  }
}

/**
 * Retrieves the current eBay OAuth user token.
 * @returns {string|null} Current token.
 */
function getAccessToken() {
  return ebayAccessToken;
}

/**
 * Manually updates the current eBay OAuth user token.
 * @param {string} token - New Bearer token.
 * @returns {void}
 */
function setAccessToken(token) {
  ebayAccessToken = token;
}

/**
 * Retrieves the current state of the network Circuit Breaker.
 * @param {string} [domain='api.ebay.com'] - Target domain.
 * @returns {{active: boolean, consecutiveFailures: number, cooldownRemainingSeconds: number, domains: object}} status info.
 */
function getCircuitBreakerStatus(domain = 'api.ebay.com') {
  const now = Date.now();
  const cb = getCircuitBreaker(domain);
  
  if (cb.state === 'OPEN' && now >= cb.brokenUntil) {
    cb.state = 'HALF-OPEN';
  }
  
  const active = now < cb.brokenUntil;
  const remainingMs = active ? (cb.brokenUntil - now) : 0;
  
  const domains = {};
  for (const [dom, state] of circuitBreakers.entries()) {
    const act = now < state.brokenUntil;
    domains[dom] = {
      active: act,
      consecutiveFailures: state.consecutiveFailures,
      cooldownRemainingSeconds: Math.round(act ? (state.brokenUntil - now) / 1000 : 0)
    };
  }

  return {
    active,
    consecutiveFailures: cb.consecutiveFailures,
    cooldownRemainingSeconds: Math.round(remainingMs / 1000),
    domains
  };
}

/**
 * Resets the circuit breaker state for testing and recovery.
 * @param {string} [domain='api.ebay.com'] - Target domain to reset, or 'all'.
 * @returns {void}
 */
function resetCircuitBreaker(domain = 'api.ebay.com') {
  if (domain === 'all') {
    circuitBreakers.clear();
  } else {
    const cb = getCircuitBreaker(domain);
    cb.consecutiveFailures = 0;
    cb.brokenUntil = 0;
    cb.state = 'CLOSED';
  }
}

/**
 * Executes a network call with AbortController timeout, Retry-After header support, and Jittered backoff.
 * @param {string} url - Target URL.
 * @param {RequestInit} [options] - Standard Fetch options.
 * @param {number} [retries=3] - Retry threshold.
 * @param {number} [delay=1000] - Starting backoff delay in ms.
 * @returns {Promise<Response>} Fetch Response object.
 */
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  const domain = getDomain(url);
  const cb = getCircuitBreaker(domain);
  const now = Date.now();
  
  if (cb.state === 'OPEN' && now >= cb.brokenUntil) {
    cb.state = 'HALF-OPEN';
    utils.logAudit("INFO", `Circuit Breaker State Transition for ${domain}: OPEN -> HALF-OPEN (cooldown expired)`);
  }
  
  if (cb.state === 'OPEN') {
    throw new Error(`Circuit Breaker Active: Skipping network call to ${url} due to prior consecutive failures.`);
  }

  const recordFailure = () => {
    updateBreakerState(domain, 'FAILURE');
  };

  const recordSuccess = () => {
    updateBreakerState(domain, 'SUCCESS');
  };
  
  const timeoutMs = options.timeout || 20000;
  
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const signal = controller.signal;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    const { timeout, ...fetchOptions } = options;
    const requestOptions = Object.assign({}, fetchOptions, { signal });
    
    try {
      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);
      
      if (response.status === 429) {
        recordFailure();
        const retryAfter = response.headers.get("retry-after");
        let sleepMs = delay;
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed) && parsed > 0) {
            sleepMs = parsed * 1000;
          }
        } else {
          sleepMs = Math.round(delay * (1 + Math.random()));
        }
        
        utils.logAudit("WARN", `Rate limited (429) on ${url}. Sleeping for ${sleepMs}ms. Attempt ${i + 1}/${retries}...`);
        if (i === retries - 1) return response;
        await new Promise(r => setTimeout(r, sleepMs));
        delay *= 2;
        continue;
      }
      
      if (response.status >= 500 && response.status < 600) {
        recordFailure();
        const sleepMs = Math.round(delay * (1 + Math.random()));
        utils.logAudit("WARN", `Server error (${response.status}) on ${url}. Retrying in ${sleepMs}ms...`);
        if (i === retries - 1) return response;
        await new Promise(r => setTimeout(r, sleepMs));
        delay *= 2;
        continue;
      }
      
      recordSuccess();
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      recordFailure();
      const isAbort = err.name === 'AbortError';
      const msg = isAbort ? `Request timed out after ${timeoutMs}ms` : err.message;
      utils.logAudit("WARN", `Network issue calling ${url}: ${msg}. Attempt ${i + 1}/${retries}.`);
      if (i === retries - 1) throw err;
      const sleepMs = Math.round(delay * (1 + Math.random()));
      await new Promise(r => setTimeout(r, sleepMs));
      delay *= 2;
    }
  }
}

/**
 * Internal wrapper that automatically refreshes the token on a 401 Unauthorized response and retries.
 * @param {string} url - Target URL.
 * @param {RequestInit} [options] - Standard fetch options.
 * @returns {Promise<Response>}
 */
async function ebayFetch(url, options = {}) {
  const makeRequest = async () => {
    const headers = Object.assign({}, options.headers, {
      "Authorization": `Bearer ${ebayAccessToken}`
    });
    return await fetchWithRetry(url, Object.assign({}, options, { headers }));
  };

  let response = await makeRequest();
  if (response.status === 401) {
    utils.logAudit("WARN", `Received 401 Unauthorized from eBay on ${url}. Refreshing access token and retrying request...`);
    await refreshEbayAccessToken();
    response = await makeRequest();
  }
  return response;
}

/**
 * Refreshes the long-lived user token using client credentials.
 * @returns {Promise<void>}
 */
async function refreshEbayAccessToken() {
  const clientId = config.getEBAY_CLIENT_ID();
  const clientSecret = config.getEBAY_CLIENT_SECRET();
  const refreshToken = config.getEBAY_REFRESH_TOKEN();

  if (clientId && clientSecret && refreshToken) {
    utils.logAudit("INFO", "Refreshing eBay Access Token using Client credentials.");
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    try {
      const response = await fetchWithRetry("https://api.ebay.com/identity/v1/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${credentials}`
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: "https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account"
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new OAuthRefreshError(`Token refresh rejected by eBay: ${JSON.stringify(data)}`);
      }
      ebayAccessToken = data.access_token;
      utils.logAudit("INFO", "Successfully obtained fresh eBay Access Token.");
    } catch (err) {
      utils.logAudit("ERROR", `OAuth Token Refresh Failed: ${err.message}`);
      if (err instanceof OAuthRefreshError) {
        throw err;
      }
      throw new OAuthRefreshError(`OAuth Refresh Connection Failed: ${err.message}`);
    }
  } else if (!ebayAccessToken) {
    const errMsg = "Credentials missing. Run --bootstrap to configure your settings.";
    utils.logAudit("FATAL", errMsg);
    console.error(`Error: ${errMsg}`);
    throw new OAuthRefreshError(errMsg);
  }
}

/**
 * Standard wrapper for the Sell Inventory API endpoints.
 * @param {string} endpoint - API path (e.g. /offer).
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE).
 * @param {object|null} [body] - optional payload data.
 * @returns {Promise<any>} Response JSON data.
 */
async function ebayRequest(endpoint, method, body = null) {
  const url = `https://api.ebay.com/sell/inventory/v1${endpoint}`;
  const response = await ebayFetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Content-Language": "en-US"
    },
    body: body ? JSON.stringify(body) : null
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const errorDetails = data?.errors
      ? data.errors.map(e => `[Error ${e.errorId}]: ${e.message} (${e.parameter ? `param: ${e.parameter}` : ''})`).join('\n')
      : text || "Unknown Error";
    throw new Error(`eBay API Call Failed on ${method} ${endpoint}\n${errorDetails}`);
  }
  return data;
}

/**
 * Outputs active return, payment, and shipping policy profiles.
 * @returns {Promise<void>}
 */
async function listPolicies() {
  await refreshEbayAccessToken();
  try {
    console.log("\n=================== EBAY BUSINESS POLICIES ===================");
    
    const fRes = await ebayFetch("https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", { headers: { "Accept": "application/json" } });
    const fData = await fRes.json();
    console.log("\n--- Fulfillment Policies ---");
    (fData.fulfillmentPolicies || []).forEach(p => {
      console.log(`ID: ${p.fulfillmentPolicyId.padEnd(15)} | Name: ${p.name.padEnd(30)} | Type: ${p.shippingOptions?.[0]?.costType || "N/A"}`);
    });

    const rRes = await ebayFetch("https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US", { headers: { "Accept": "application/json" } });
    const rData = await rRes.json();
    console.log("\n--- Return Policies ---");
    (rData.returnPolicies || []).forEach(p => {
      console.log(`ID: ${p.returnPolicyId.padEnd(15)} | Name: ${p.name.padEnd(30)} | Returns Accepted: ${p.returnsAccepted}`);
    });

    const pRes = await ebayFetch("https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US", { headers: { "Accept": "application/json" } });
    const pData = await pRes.json();
    console.log("\n--- Payment Policies ---");
    (pData.paymentPolicies || []).forEach(p => {
      console.log(`ID: ${p.paymentPolicyId.padEnd(15)} | Name: ${p.name.padEnd(30)} | Immediate Pay: ${p.immediatePayment}`);
    });
    console.log("\n==============================================================");
  } catch (err) {
    console.error("Failed to list policies:", err.message);
    throw err;
  }
}

/**
 * Automatically creates or fetches policy profiles on the seller account.
 * @param {string} [shippingOption=USPS_GROUND] - Shipping selector.
 * @param {string} [returnOption=NO_RETURNS] - Return policy selector.
 * @param {boolean} [immediatePay=true] - Immediate payment requirement toggle.
 * @returns {Promise<{fulfillmentId: string, paymentId: string, returnId: string}>} Resolved Policy IDs.
 */
async function getOrCreateListingPolicies(shippingOption = "USPS_GROUND", returnOption = "NO_RETURNS", immediatePay = true) {
  utils.logAudit("INFO", `Enforcing listing policies on eBay: Shipping=${shippingOption}, Return=${returnOption}, ImmediatePay=${immediatePay}`);
  
  let fulfillmentId = config.getEBAY_FULFILLMENT_POLICY_ID();
  let paymentId = config.getEBAY_PAYMENT_POLICY_ID();
  let returnId = config.getEBAY_RETURN_POLICY_ID();

  if (fulfillmentId && paymentId && returnId && shippingOption === "USPS_GROUND" && returnOption === "NO_RETURNS" && immediatePay) {
    return { fulfillmentId, paymentId, returnId };
  }

  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
  };

  // 1. Return Policy
  let returnPolicyName = "ListerReturnPolicy_NoReturns";
  let returnsAccepted = false;
  let returnPeriod = null;
  let refundMethod = null;
  let shippingCostPayer = null;

  if (returnOption === "30_DAYS_BUYER_PAYS") {
    returnPolicyName = "ListerReturnPolicy_30DaysBuyerPays";
    returnsAccepted = true;
    returnPeriod = { value: 30, unit: "DAY" };
    refundMethod = "MONEY_BACK";
    shippingCostPayer = "BUYER";
  } else if (returnOption === "30_DAYS_FREE") {
    returnPolicyName = "ListerReturnPolicy_30DaysFree";
    returnsAccepted = true;
    returnPeriod = { value: 30, unit: "DAY" };
    refundMethod = "MONEY_BACK";
    shippingCostPayer = "SELLER";
  }

  try {
    const res = await ebayFetch("https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US", { headers });
    const data = await res.json();
    const existing = (data.returnPolicies || []).find(p => p.name === returnPolicyName);
    if (existing) {
      returnId = existing.returnPolicyId;
    } else {
      const payload = {
        name: returnPolicyName,
        description: `Returns managed by Auto Lister: ${returnOption}`,
        marketplaceId: "EBAY_US",
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
        returnsAccepted
      };
      if (returnsAccepted) {
        payload.returnPeriod = returnPeriod;
        payload.refundMethod = refundMethod;
        payload.shippingCostPayer = shippingCostPayer;
      }
      const createRes = await ebayFetch("https://api.ebay.com/sell/account/v1/return_policy", {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(`Return policy creation failed: ${JSON.stringify(createData)}`);
      returnId = createData.returnPolicyId;
    }
  } catch (err) {
    utils.logAudit("ERROR", `Failed to resolve return policy: ${err.message}`);
    throw err;
  }

  // 2. Shipping Policy
  let shippingPolicyName = "ListerFulfillmentPolicy_USPSGround";
  let carrier = "USPS";
  let serviceCode = "US_USPSGroundAdvantage";
  let costType = "CALCULATED";

  if (shippingOption === "USPS_PRIORITY") {
    shippingPolicyName = "ListerFulfillmentPolicy_USPSPriority";
    carrier = "USPS";
    serviceCode = "US_USPSPriority";
  } else if (shippingOption === "UPS_GROUND") {
    shippingPolicyName = "ListerFulfillmentPolicy_UPSGround";
    carrier = "UPS";
    serviceCode = "US_UPSGround";
  } else if (shippingOption === "FLAT_RATE_STANDARD") {
    shippingPolicyName = "ListerFulfillmentPolicy_FlatStandard";
    carrier = "USPS";
    serviceCode = "US_USPSGroundAdvantage";
    costType = "FLAT_RATE";
  }

  try {
    const res = await ebayFetch("https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", { headers });
    const data = await res.json();
    const existing = (data.fulfillmentPolicies || []).find(p => p.name === shippingPolicyName);
    if (existing) {
      fulfillmentId = existing.fulfillmentPolicyId;
    } else {
      const payload = {
        name: shippingPolicyName,
        description: `Shipping managed by Auto Lister: ${shippingOption}`,
        marketplaceId: "EBAY_US",
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
        handlingTime: { value: 1, unit: "DAY" },
        shippingOptions: [{
          optionType: "DOMESTIC",
          costType,
          shippingServices: [{
            shippingCarrierCode: carrier,
            shippingServiceCode: serviceCode,
            buyerResponsibleForShippingFee: costType === "CALCULATED" ? true : false,
            freeShipping: false
          }]
        }]
      };
      if (costType === "FLAT_RATE") {
        payload.shippingOptions[0].shippingServices[0].shippingFee = { currency: "USD", value: "5.00" };
      }
      const createRes = await ebayFetch("https://api.ebay.com/sell/account/v1/fulfillment_policy", {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(`Fulfillment policy creation failed: ${JSON.stringify(createData)}`);
      fulfillmentId = createData.fulfillmentPolicyId;
    }
  } catch (err) {
    utils.logAudit("ERROR", `Failed to resolve fulfillment policy: ${err.message}`);
    throw err;
  }

  // 3. Payment Policy
  const paymentPolicyName = immediatePay ? "ListerPaymentPolicy_Immediate" : "ListerPaymentPolicy_Standard";
  try {
    const res = await ebayFetch("https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US", { headers });
    const data = await res.json();
    const existing = (data.paymentPolicies || []).find(p => p.name === paymentPolicyName);
    if (existing) {
      paymentId = existing.paymentPolicyId;
    } else {
      const payload = {
        name: paymentPolicyName,
        description: `Payment managed by Auto Lister. Immediate Pay: ${immediatePay}`,
        marketplaceId: "EBAY_US",
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
        immediatePayment: immediatePay
      };
      const createRes = await ebayFetch("https://api.ebay.com/sell/account/v1/payment_policy", {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(`Payment policy creation failed: ${JSON.stringify(createData)}`);
      paymentId = createData.paymentPolicyId;
    }
  } catch (err) {
    utils.logAudit("ERROR", `Failed to resolve payment policy: ${err.message}`);
    throw err;
  }

  return { fulfillmentId, paymentId, returnId };
}

/**
 * Retrieves the required category aspect names from taxonomy.
 * @param {string} categoryId - Target category.
 * @returns {Promise<string[]>} List of required aspect names.
 */
async function getRequiredCategoryAspects(categoryId) {
  try {
    const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`;
    const response = await ebayFetch(url, {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) return [];
    
    const data = await response.json();
    const aspects = data.aspects || [];
    return aspects
      .filter(a => a.aspectConstraint?.aspectRequired === true)
      .map(a => a.localizedAspectName);
  } catch (err) {
    return [];
  }
}

/**
 * Returns dynamic category suggested targets.
 * @param {string} title - Product draft title.
 * @returns {Promise<{id: string, name: string, path: string}[]>} List of suggestions.
 */
async function getCategorySuggestions(title) {
  if (!ebayAccessToken) return [];
  try {
    const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(title)}`;
    const response = await ebayFetch(url, {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) return [];
    const data = await response.json();
    const suggestions = data.categorySuggestions || [];
    return suggestions.map(s => ({
      id: s.category.categoryId,
      name: s.category.categoryName,
      path: (s.categoryTreeNodeAncestors || []).map(a => a.categoryTreeNodeName).join(" > ") + " > " + s.category.categoryName
    })).slice(0, 5);
  } catch (err) {
    utils.logAudit("WARN", `Failed to get category suggestions: ${err.message}`);
  }
  return [];
}

/**
 * Convenience helper to return the first suggested category ID.
 * @param {string} title - Product draft title.
 * @returns {Promise<string|null>} Category ID or null.
 */
async function suggestCategory(title) {
  const suggestions = await getCategorySuggestions(title);
  if (suggestions.length > 0) {
    return suggestions[0].id;
  }
  return null;
}

/**
 * Fetches specifications and dimensions matching a UPC barcode.
 * @param {string} upc - Target UPC string.
 * @returns {Promise<{title: string, brand: string, mpn: string, aspects: object}|null>} Resolved catalog specs.
 */
async function lookupUPCOnEbay(upc) {
  if (!ebayAccessToken) return null;
  if (!upc) return null;
  const cleanUpc = String(upc).trim().replace(/[\s-]/g, '');
  if (!/^\d{8,14}$/.test(cleanUpc)) {
    utils.logAudit("WARN", `UPC barcode "${upc}" is invalid (must be 8-14 digits). Skipping catalog lookup.`);
    return null;
  }
  utils.logAudit("INFO", `Looking up UPC barcode ${cleanUpc} on eBay Catalog API`);
  try {
    const response = await ebayFetch(`https://api.ebay.com/commerce/catalog/v1/product_summary?gtin=${encodeURIComponent(cleanUpc)}`, {
      headers: {
        "Accept": "application/json"
      }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const product = data.productSummaries?.[0];
    if (product) {
      utils.logAudit("INFO", `UPC lookup successful: ${product.title}`);
      
      const imageUrls = [];
      if (product.image && product.image.imageUrl) {
        imageUrls.push(product.image.imageUrl);
      }
      if (Array.isArray(product.additionalImages)) {
        product.additionalImages.forEach(img => {
          if (img.imageUrl && !imageUrls.includes(img.imageUrl)) {
            imageUrls.push(img.imageUrl);
          }
        });
      }

      return {
        title: product.title,
        brand: product.brand,
        mpn: product.mpn,
        stockImageUrls: imageUrls,
        aspects: (product.aspects || []).reduce((acc, a) => {
          acc[a.name] = a.values?.[0] || "";
          return acc;
        }, {})
      };
    }
  } catch (err) {
    utils.logAudit("WARN", `UPC Lookup failed: ${err.message}`);
  }
  return null;
}

/**
 * Ends/withdraws a live listing from the eBay marketplace.
 * @param {string} sku - Product SKU.
 * @param {string|null} [offerId] - eBay Offer ID.
 * @returns {Promise<string>} Live Listing ID withdrawn.
 */
async function endListingOnEbay(sku, offerId = null) {
  console.log(`Ending active eBay listing for SKU: ${sku}...`);
  utils.logAudit("INFO", `Request to end listing for SKU: ${sku}`);

  try {
    let activeOfferId = offerId;
    
    if (!activeOfferId) {
      const offerData = await ebayRequest(`/offer?sku=${encodeURIComponent(sku)}`, "GET");
      const activeOffer = (offerData.offers || []).find(o => o.status === "LISTED");
      if (!activeOffer) {
        throw new Error("No active listed offer found on eBay for this SKU.");
      }
      activeOfferId = activeOffer.offerId;
    }

    const res = await ebayRequest(`/offer/${encodeURIComponent(activeOfferId)}/withdraw`, "POST");
    console.log(`Successfully withdrew listing from eBay. Listing ID: ${res.listingId}`);
    utils.logAudit("INFO", `eBay Listing withdrawn: ${res.listingId}`);
    
    // Update local status in history
    try {
      const history = utils.readJsonFileSecure(config.historyPath, []);
      const item = history.find(i => i.sku === sku);
      if (item) {
        item.status = "ENDED";
        utils.writeJsonFileSecure(config.historyPath, history);
      }
    } catch (e) {}
    
    return res.listingId;
  } catch (err) {
    console.error(`Failed to end eBay listing: ${err.message}`);
    utils.logAudit("ERROR", `End listing failed: ${err.message}`);
    throw err;
  }
}

/**
 * Imports active offers and inventory from eBay, writing it to listings-history.json.
 * @returns {Promise<void>}
 */
async function syncListingsFromEbay() {
  console.log("Syncing active listings from eBay account...");
  utils.logAudit("INFO", "Starting eBay active listing sync.");
  
  await refreshEbayAccessToken();
  try {
    const history = utils.readJsonFileSecure(config.historyPath, []);
    const invRes = await ebayRequest("/inventory_item?offset=0&limit=100", "GET");
    const items = invRes.inventoryItems || [];
    
    console.log(`Found ${items.length} inventory item(s) on eBay. Fetching active offers...`);
    
    let syncCount = 0;
    for (const item of items) {
      const sku = item.sku;
      try {
        const offerRes = await ebayRequest(`/offer?sku=${encodeURIComponent(sku)}`, "GET");
        const offers = offerRes.offers || [];
        const activeOffer = offers.find(o => o.status === "LISTED");
        
        if (activeOffer) {
          const index = history.findIndex(h => h.sku === sku);
          const entry = {
            timestamp: activeOffer.listingPolicies?.fulfillmentPolicyId ? new Date().toISOString() : (history[index]?.timestamp || new Date().toISOString()),
            sku,
            listingId: activeOffer.listingId,
            title: item.product?.title || "eBay Listing",
            price: parseFloat(activeOffer.pricingSummary?.price?.value || 0),
            categoryId: activeOffer.categoryId,
            offerId: activeOffer.offerId,
            shopifyId: history[index]?.shopifyId || null,
            status: "ACTIVE"
          };
          
          if (index !== -1) {
            history[index] = entry;
          } else {
            history.push(entry);
          }
          syncCount++;
        }
      } catch (err) {
        utils.logAudit("WARN", `Failed to fetch offer for SKU ${sku}: ${err.message}`);
      }
    }
    
    utils.writeJsonFileSecure(config.historyPath, history);
    console.log(`Successfully synced ${syncCount} active listing(s) to local history database!`);
    utils.logAudit("INFO", `Sync completed. ${syncCount} items active.`);
  } catch (err) {
    console.error("Listing sync failed:", err.message);
    utils.logAudit("ERROR", `Listing sync failed: ${err.message}`);
  }
}

/**
 * Searches the eBay Catalog API for matching products and retrieves their stock image URLs.
 * @param {string} keywords - Search keywords.
 * @returns {Promise<string[]>} List of stock image URLs.
 */
async function searchCatalogStockPhotos(keywords) {
  if (!ebayAccessToken) return [];
  utils.logAudit("INFO", `Searching eBay Catalog for keywords: "${keywords}"`);
  const urls = [];
  try {
    const response = await ebayFetch(`https://api.ebay.com/commerce/catalog/v1/product_summary?q=${encodeURIComponent(keywords)}&limit=3`, {
      headers: {
        "Accept": "application/json"
      }
    });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.productSummaries)) {
        for (const product of data.productSummaries) {
          if (product.image && product.image.imageUrl && !urls.includes(product.image.imageUrl)) {
            urls.push(product.image.imageUrl);
          }
          if (Array.isArray(product.additionalImages)) {
            for (const img of product.additionalImages) {
              if (img.imageUrl && !urls.includes(img.imageUrl)) {
                urls.push(img.imageUrl);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    utils.logAudit("WARN", `Catalog keyword stock photo search failed: ${err.message}`);
  }

  // Fallback to active listing images search using Browse API if catalog returned no images
  if (urls.length === 0) {
    utils.logAudit("INFO", `No catalog stock photos found for "${keywords}". Falling back to active listings search for images.`);
    try {
      const browseUrl = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=5`;
      const browseResponse = await ebayFetch(browseUrl, {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      if (browseResponse.ok) {
        const browseData = await browseResponse.json();
        if (browseData.itemSummaries) {
          for (const item of browseData.itemSummaries) {
            if (item.image && item.image.imageUrl && !urls.includes(item.image.imageUrl)) {
              urls.push(item.image.imageUrl);
            }
            if (Array.isArray(item.additionalImages)) {
              for (const img of item.additionalImages) {
                if (img.imageUrl && !urls.includes(img.imageUrl)) {
                  urls.push(img.imageUrl);
                }
              }
            }
          }
        }
      }
    } catch (browseErr) {
      utils.logAudit("WARN", `Browse API fallback stock photo search failed: ${browseErr.message}`);
    }
  }

  return urls;
}

/**
 * Searches eBay active comps using Browse API to compute price statistics (Min, Max, Avg).
 * Falls back to condition-based pricing recommendations if Browse API is unavailable.
 * @param {string} keywords - Search keywords.
 * @param {string} [condition="USED_EXCELLENT"] - Item condition.
 * @returns {Promise<{minPrice: number, maxPrice: number, avgPrice: number, source: string}>} Price statistics.
 */
async function searchEbayComps(keywords, condition = "USED_EXCELLENT") {
  if (!ebayAccessToken) {
    return getFallbackPrices(condition, keywords);
  }
  
  utils.logAudit("INFO", `Searching eBay Browse API comps for keywords: "${keywords}"`);
  try {
    let conditionId = "3000"; 
    if (condition === "NEW") conditionId = "1000";
    else if (condition === "FOR_PARTS_OR_NOT_WORKING") conditionId = "7000";

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=10&filter=conditions:{${conditionId}}`;
    const response = await ebayFetch(url, {
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Browse API returned status ${response.status}`);
    }

    const data = await response.json();
    const items = data.itemSummaries || [];
    if (items.length === 0) {
      return getFallbackPrices(condition, keywords);
    }

    const prices = items
      .map(item => parseFloat(item.price?.value))
      .filter(p => !isNaN(p) && p > 0);

    if (prices.length === 0) {
      return getFallbackPrices(condition, keywords);
    }

    // Advanced IQR Outlier Trimming: remove data points beyond 1.5 * IQR
    let finalPrices = prices;
    if (prices.length >= 4) {
      prices.sort((a, b) => a - b);
      const getPercentile = (arr, p) => {
        const index = (arr.length - 1) * p;
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index - lower;
        return arr[lower] * (1 - weight) + arr[upper] * weight;
      };
      const q1 = getPercentile(prices, 0.25);
      const q3 = getPercentile(prices, 0.75);
      const iqr = q3 - q1;
      const lowerBound = q1 - 1.5 * iqr;
      const upperBound = q3 + 1.5 * iqr;
      finalPrices = prices.filter(p => p >= lowerBound && p <= upperBound);
      if (finalPrices.length === 0) {
        finalPrices = prices;
      }
    }

    const minPrice = Math.min(...finalPrices);
    const maxPrice = Math.max(...finalPrices);
    const sum = finalPrices.reduce((a, b) => a + b, 0);
    const avgPrice = parseFloat((sum / finalPrices.length).toFixed(2));

    return {
      minPrice: parseFloat(minPrice.toFixed(2)),
      maxPrice: parseFloat(maxPrice.toFixed(2)),
      avgPrice,
      source: "eBay Browse API Comps"
    };
  } catch (err) {
    utils.logAudit("WARN", `Browse API comps search failed: ${err.message}. Using fallback pricing.`);
    return getFallbackPrices(condition, keywords);
  }
}

function getFallbackPrices(condition, keywords = "") {
  let base = 29.99;
  const lower = String(keywords || '').toLowerCase();
  
  if (lower.includes("phone") || lower.includes("laptop") || lower.includes("camera") || lower.includes("electronics") || lower.includes("computer") || lower.includes("audio") || lower.includes("console")) {
    base = 79.99;
  } else if (lower.includes("shirt") || lower.includes("shoe") || lower.includes("boot") || lower.includes("clothing") || lower.includes("coat") || lower.includes("pants") || lower.includes("bag")) {
    base = 24.99;
  } else if (lower.includes("book") || lower.includes("dvd") || lower.includes("cd") || lower.includes("comic") || lower.includes("movie") || lower.includes("game")) {
    base = 12.99;
  } else if (lower.includes("card") || lower.includes("coin") || lower.includes("art") || lower.includes("vintage") || lower.includes("antique") || lower.includes("stamp")) {
    base = 45.00;
  } else if (lower.includes("toy") || lower.includes("puzzle") || lower.includes("doll") || lower.includes("lego") || lower.includes("action figure") || lower.includes("hobby")) {
    base = 19.99;
  } else if (lower.includes("tool") || lower.includes("drill") || lower.includes("saw") || lower.includes("lawn") || lower.includes("garden") || lower.includes("kitchen") || lower.includes("home")) {
    base = 34.99;
  } else if (lower.includes("sport") || lower.includes("golf") || lower.includes("tent") || lower.includes("fish") || lower.includes("bike") || lower.includes("fitness")) {
    base = 39.99;
  } else if (lower.includes("jewelry") || lower.includes("watch") || lower.includes("ring") || lower.includes("necklace") || lower.includes("gold") || lower.includes("silver")) {
    base = 49.99;
  } else if (lower.includes("cream") || lower.includes("makeup") || lower.includes("perfume") || lower.includes("shampoo") || lower.includes("beauty") || lower.includes("health")) {
    base = 21.99;
  } else if (lower.includes("parts") || lower.includes("car") || lower.includes("wheel") || lower.includes("tire") || lower.includes("engine") || lower.includes("automotive")) {
    base = 55.00;
  }

  if (condition === "NEW") {
    base = parseFloat((base * 1.25).toFixed(2));
  } else if (condition === "FOR_PARTS_OR_NOT_WORKING") {
    base = parseFloat((base * 0.3).toFixed(2));
  }

  return {
    minPrice: parseFloat((base * 0.7).toFixed(2)),
    maxPrice: parseFloat((base * 1.3).toFixed(2)),
    avgPrice: base,
    source: "Condition & Category Rule Engine Defaults"
  };
}

/**
 * Automatically fetches active listings, checks market comps, and adjusts active offer prices.
 * @returns {Promise<void>}
 */
async function runDailyRepricer() {
  utils.logAudit("INFO", "Starting automated daily pricing comp updates...");
  const history = utils.readJsonFileSecure(config.historyPath, []);
  let updatedCount = 0;

  for (const item of history) {
    if (item.status === 'ACTIVE' && item.offerId && !item.priceLocked) {
      try {
        const comps = await searchEbayComps(item.title, item.condition);
        if (comps && comps.avgPrice) {
          let strategy = config.getDEFAULT_PRICING_STRATEGY();
          let targetPrice;
          if (strategy === 'FAST') {
            targetPrice = parseFloat((comps.avgPrice * 0.9).toFixed(2));
          } else if (strategy === 'PREMIUM') {
            targetPrice = parseFloat((comps.avgPrice * 1.1).toFixed(2));
          } else if (strategy === 'UNDERCUT') {
            targetPrice = parseFloat((comps.minPrice - 0.05).toFixed(2));
          } else {
            targetPrice = parseFloat((comps.avgPrice * 1.0).toFixed(2));
          }
          // Apply pricing bounds if set
          if (item.priceFloor && targetPrice < item.priceFloor) {
            targetPrice = item.priceFloor;
          }
          if (item.priceCap && targetPrice > item.priceCap) {
            targetPrice = item.priceCap;
          }

          if (Math.abs(targetPrice - item.price) > 0.05) {
            utils.logAudit("INFO", `Repricing SKU ${item.sku} from $${item.price} to $${targetPrice} based on comps.`);
            
            // To update eBay price, we query the offer details, update price, and put back.
            const offerData = await ebayRequest(`/offer/${item.offerId}`, "GET");
            if (offerData) {
              offerData.price = { value: String(targetPrice), currency: "USD" };
              await ebayRequest(`/offer/${item.offerId}`, "PUT", offerData);
              item.price = targetPrice;
              updatedCount++;
            }
          }
        }
      } catch (err) {
        utils.logAudit("WARN", `Could not reprice SKU ${item.sku}: ${err.message}`);
      }
    }
  }

  if (updatedCount > 0) {
    utils.writeJsonFileSecure(config.historyPath, history);
    utils.logAudit("INFO", `Automated daily repricing finished. Updated ${updatedCount} listing(s).`);
  } else {
    utils.logAudit("INFO", "Automated daily repricing finished. No listings updated.");
  }
}

/**
 * Searches eBay comps and extracts the first valid 12-digit UPC barcode from results.
 * @param {string} keywords - Product title or search query.
 * @returns {Promise<string|null>} The detected UPC barcode or null.
 */
async function findUpcFromComps(keywords) {
  if (!ebayAccessToken) return null;
  try {
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(keywords)}&limit=5`;
    const response = await ebayFetch(url, {
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const items = data.itemSummaries || [];
    
    for (const item of items) {
      if (item.title) {
        const matches = item.title.match(/\b\d{12}\b/);
        if (matches) return matches[0];
      }
      
      if (item.itemId) {
        try {
          const itemUrl = `https://api.ebay.com/buy/browse/v1/item/${item.itemId}`;
          const itemRes = await ebayFetch(itemUrl, {
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/json"
            }
          });
          if (itemRes.ok) {
            const itemData = await itemRes.json();
            if (itemData.upc && /^\d{12}$/.test(itemData.upc)) {
              return itemData.upc;
            }
            if (itemData.gtin && /^\d{12}$/.test(itemData.gtin)) {
              return itemData.gtin;
            }
          }
        } catch (e) {
          // ignore detail check errors
        }
      }
    }
  } catch (err) {
    utils.logAudit("WARN", `Error finding UPC from comps: ${err.message}`);
  }
  return null;
}

/**
 * Sends a discount offer to watchers of an active eBay item.
 * @param {string} itemId - The eBay listing/item ID.
 * @param {number} discountPercentage - Discount percent (e.g. 10).
 * @returns {Promise<object>} The eBay API response object.
 */
async function sendOffersToWatchers(itemId, discountPercentage = 10) {
  const payload = {
    offeredItems: [
      {
        itemId: itemId,
        discountPercentage: discountPercentage
      }
    ]
  };
  
  const url = `https://api.ebay.com/sell/negotiation/v1/send_offer_to_interested_buyers`;
  const response = await ebayFetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  
  if (!response.ok) {
    throw new Error(`Failed to send offer to interested buyers: ${text || "Unknown Error"}`);
  }
  return data;
}

module.exports = {
  getAccessToken,
  setAccessToken,
  fetchWithRetry,
  refreshEbayAccessToken,
  ebayRequest,
  listPolicies,
  getOrCreateListingPolicies,
  getRequiredCategoryAspects,
  getCategorySuggestions,
  suggestCategory,
  lookupUPCOnEbay,
  endListingOnEbay,
  syncListingsFromEbay,
  searchCatalogStockPhotos,
  searchEbayComps,
  getCircuitBreakerStatus,
  resetCircuitBreaker,
  runDailyRepricer,
  findUpcFromComps,
  sendOffersToWatchers
};
