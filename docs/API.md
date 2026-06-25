# 🔌 eBay Multi-Channel Lister Pro — API Documentation

This document describes all API endpoints exposed by the zero-dependency web dashboard server (default port: `45900`).

---

## 🔒 Authentication & Rate Limits

1. **Local Authentication Mode**:
   - Exposes access tokens using the `X-Lister-API-Key` HTTP Header or `?apiKey=` query parameter.
   - When `GOOGLE_CLIENT_ID` is set, non-open routes require a valid `sessionId` cookie generated via Google Sign-In.
2. **Rate Limiting**:
   - Standard endpoints: Token bucket rate limited (60 requests/minute per client IP).
   - `/api/analyze` endpoint: 5 requests/minute per client IP to prevent AI billing spikes.

---

## 📂 Endpoints Directory

### 1. General & System Routes

#### `GET /health`
- **Description**: Lightweight health status endpoint for load balancers/monitors.
- **Authentication**: None (Bypassed)
- **Response Shape**:
  ```json
  {
    "status": "ok",
    "timestamp": "2026-06-25T17:00:00.000Z",
    "version": "1.0.0"
  }
  ```

#### `GET /api/status`
- **Description**: Returns circuit breaker connectivity details, pre-flight diagnostics, and channel authentication status.
- **Authentication**: None (Bypassed)
- **Response Shape**:
  ```json
  {
    "status": "CONNECTED",
    "circuitBreaker": {
      "active": false,
      "failures": 0,
      "lastFailureTime": 0
    },
    "diagnostics": "OK",
    "ebayAuthenticated": true,
    "shopifyConnected": false
  }
  ```

#### `GET /api/metrics`
- **Description**: Returns latency histograms, CPU usage, memory heap allocations, and request metrics.
- **Authentication**: None (Bypassed)
- **Response Shape**:
  ```json
  {
    "uptime": 125,
    "totalRequests": 14,
    "endpointCounts": { "GET /api/status": 10 },
    "endpointErrors": {},
    "latency": {},
    "memory": { "rss": 42000000, "heapUsed": 15000000 },
    "cpu": { "user": 12000, "system": 4000 }
  }
  ```

#### `GET /api/logs`
- **Description**: Returns the active local structured audit log tail.
- **Authentication**: Required
- **Response Shape**:
  ```json
  {
    "logs": "[2026-06-25 12:00:00] INFO: Server started on port 45900\n"
  }
  ```

#### `POST /api/logs` | `DELETE /api/logs`
- **Description**: Writes a custom message to the audit log (POST) or clears the log file (DELETE).
- **Authentication**: Required
- **Payload (POST)**: `{"level": "INFO", "message": "Custom event"}`
- **Response Shape**: `{"success": true}`

---

### 2. User Authentication & Billing

#### `GET /api/auth/google/login`
- **Description**: Redirects users to the Google Accounts consent page. In local development without Google credentials, it automatically logs in a mock user and redirects home.
- **Authentication**: None (Bypassed)

#### `GET /api/auth/google/callback`
- **Description**: OAuth authorization code flow callback. Exchange code for Google ID token, checks billing database, registers a session, and sets a cookie.
- **Authentication**: None (Bypassed)
- **Query Params**: `?code=OAUTH_CODE`

#### `POST /api/auth/logout`
- **Description**: Destroys active user session.
- **Authentication**: Required
- **Response Shape**: `{"success": true}`

#### `GET /api/auth/session`
- **Description**: Checks session viability and returns current user details and feature flags.
- **Authentication**: None (Bypassed)
- **Response Shape**:
  ```json
  {
    "authenticated": true,
    "user": {
      "email": "vincekinney1991@proton.me",
      "name": "Vincent Kinney",
      "isPremium": true
    },
    "googleLoginEnabled": false
  }
  ```

#### `POST /api/billing/create-checkout-session`
- **Description**: Initiates a Stripe Checkout Session for Lister Pro Premium. If `STRIPE_SECRET_KEY` is not configured, it redirects to a local mock success route.
- **Authentication**: Required
- **Response Shape**: `{"url": "https://checkout.stripe.com/..."}`

#### `POST /api/billing/webhook`
- **Description**: Receives incoming Stripe events (`checkout.session.completed` and `customer.subscription.deleted`) to manage subscriber entitlements.
- **Authentication**: Cryptographic signature validation via `stripe-signature` header.

---

### 3. Listing & Analysis Operations

#### `POST /api/analyze`
- **Description**: Triggers Google Gemini Vision AI to inspect local images, detect condition defects, extract model aspects, and look up matching UPC comps.
- **Authentication**: Required
- **Payload**:
  ```json
  {
    "images": ["image1.jpg", "image2.jpg"],
    "notes": "Optional extra item details"
  }
  ```
- **Response Shape**:
  ```json
  {
    "title": "Nike Air Max 90 Running Shoes Size 10",
    "brand": "Nike",
    "model": "Air Max 90",
    "detectedUPC": "194956839211",
    "flaws": "Minor scuffs on outsole",
    "suggestedPrice": 59.99
  }
  ```

#### `POST /api/publish`
- **Description**: Concurrently cross-lists an item to eBay, Shopify, WooCommerce, and Etsy.
- **Authentication**: Required
- **Payload**:
  ```json
  {
    "sku": "NIKE-AM90-001",
    "listing": {
      "title": "Nike Air Max 90 Size 10",
      "description": "Nike Air Max 90 in excellent condition.",
      "suggestedPrice": 59.99,
      "brand": "Nike",
      "model": "Air Max 90",
      "upc": "194956839211",
      "condition": "USED_EXCELLENT"
    },
    "imageUrls": ["https://tmpfiles.org/dl/..."],
    "platforms": ["ebay", "shopify", "woocommerce", "etsy"]
  }
  ```
- **Response Shape**:
  ```json
  {
    "success": true,
    "sku": "NIKE-AM90-001",
    "ebay": { "success": true, "id": "110293849102" },
    "shopify": { "success": true, "id": "9028381928" },
    "woocommerce": { "success": true, "id": 1042 },
    "etsy": { "success": true, "id": "182938492" }
  }
  ```

#### `POST /api/save-draft`
- **Description**: Saves or overwrites a draft listing to the local history database.
- **Authentication**: Required
- **Payload**: Same as `POST /api/publish` payload.
- **Response Shape**: `{"success": true, "sku": "NIKE-AM90-001"}`

#### `POST /api/publish-draft`
- **Description**: Publishes an existing saved draft to active listings across channels.
- **Authentication**: Required
- **Payload**: `{"sku": "NIKE-AM90-001", "platforms": ["ebay"]}`

#### `POST /api/end-listing`
- **Description**: Withdraws and ends an active listing from eBay.
- **Authentication**: Required
- **Payload**: `{"sku": "NIKE-AM90-001", "offerId": "10029384910"}`
- **Response Shape**: `{"success": true}`

#### `GET /api/history`
- **Description**: Returns all saved listings history.
- **Authentication**: Required
- **Response Shape**:
  ```json
  {
    "listings": [
      {
        "sku": "NIKE-AM90-001",
        "title": "Nike Air Max 90",
        "status": "ACTIVE",
        "ebayId": "110293849102"
      }
    ]
  }
  ```

#### `POST /api/sync`
- **Description**: Triggers a manual inventory sync from your active eBay listings.
- **Authentication**: Required

---

### 4. Cross-Posting Platform Specifics

#### `POST /api/publish/woocommerce`
- **Description**: Publishes direct product payload to WooCommerce.
- **Authentication**: Required
- **Payload**: `{"sku": "SKU", "listing": {...}, "imageUrls": [...]}`

#### `POST /api/publish/etsy`
- **Description**: Publishes direct product payload to Etsy. Truncates titles to Etsy's 140 character limit.
- **Authentication**: Required

#### `POST /api/offers/auto-send`
- **Description**: Triggers sending discount offers to watching eBay customers.
- **Authentication**: Required
- **Payload**: `{"sku": "SKU", "discountPercentage": 10}`

#### `POST /api/export/mercari` | `POST /api/export/poshmark`
- **Description**: Returns pre-formatted titles, tags, and pricing descriptions optimized for manual copying/pasting onto Mercari or Poshmark.
- **Authentication**: Required
- **Payload**: `{"sku": "SKU"}`
