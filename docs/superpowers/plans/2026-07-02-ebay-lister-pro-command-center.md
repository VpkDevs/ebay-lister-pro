# eBay Lister Pro Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a seller command center that makes listing readiness, inventory progress, channel health, sync failures, and next actions visible from the main dashboard.

**Architecture:** Keep the current CommonJS Node server and vanilla single-file dashboard. Add one focused backend summary contract, render a compact command center in `public/index.html`, improve confirmation flows with the existing modal style, and document the new operating model.

**Tech Stack:** Node.js 18+, CommonJS, native `http`, native `node:test`, vanilla HTML/CSS/JavaScript, existing JSON file persistence in `data/`.

## Global Constraints

- Preserve the existing dirty worktree. Stage and commit only files touched by the current task.
- Keep the current native Node.js and vanilla HTML/CSS/JS architecture.
- Avoid framework migration.
- Avoid database migration away from JSON files.
- Avoid replacing the Chrome extension architecture.
- Avoid deep eBay/Shopify/WooCommerce/Etsy API rewrites.
- Do not expose secrets, raw tokens, or full environment values in UI or logs.
- Browser-visible text must fit on mobile and desktop without overlapping controls.
- Run `node test-suite.js` before final completion.

---

## File Structure

- Modify `webServer.js`: add pure summary helpers and `GET /api/dashboard/summary`.
- Modify `test-suite.js`: add integration coverage for the new dashboard summary contract.
- Modify `public/index.html`: add the command-center shell, CSS, rendering helpers, refresh hooks, and safer confirmation modal.
- Modify `docs/ARCHITECTURE.md`: replace placeholder content with the actual command-center data flow.
- Modify `docs/SETUP.md`: document first-run and command-center smoke workflow.
- Modify `docs/ENVIRONMENT.md`: replace placeholder variables with the real variables from `.env.example`.
- Modify `docs/TESTING_STRATEGY.md`: document automated and manual verification for this app.
- Modify `docs/ROADMAP.md`: update the current roadmap around the command-center upgrade.
- Modify `docs/QUICK_WINS.md`: mark the docs quick win as done and add follow-up candidates.

---

### Task 1: Backend Dashboard Summary Contract

**Files:**
- Modify: `test-suite.js`
- Modify: `webServer.js`

**Interfaces:**
- Produces: `GET /api/dashboard/summary`
- Response shape:

```json
{
  "success": true,
  "generatedAt": "2026-07-02T00:00:00.000Z",
  "readiness": {
    "diagnostics": "OK",
    "ebayAuthenticated": true,
    "geminiConfigured": true,
    "circuitBreakerActive": false,
    "channels": {
      "ebay": true,
      "gemini": true,
      "shopify": false,
      "woocommerce": false,
      "etsy": false,
      "mercari": true,
      "poshmark": true
    }
  },
  "inventory": {
    "total": 3,
    "active": 1,
    "drafts": 1,
    "ended": 1,
    "totalValue": 175.49,
    "veroWarnings": 1,
    "latestDrafts": [
      {
        "sku": "SUMMARY-DRAFT",
        "title": "Draft Jacket",
        "price": 50,
        "timestamp": "2026-07-02T00:00:00.000Z",
        "veroWarning": true
      }
    ]
  },
  "syncQueue": {
    "total": 1,
    "ready": 1,
    "backingOff": 0,
    "exhausted": 0,
    "maxAttempts": 10
  },
  "nextActions": [
    {
      "id": "process-sync-queue",
      "label": "Process ready sync jobs",
      "priority": "high"
    }
  ],
  "system": {
    "uptimeSeconds": 60,
    "totalRequests": 12,
    "activeSockets": 1,
    "memoryMb": {
      "rss": 64,
      "heapUsed": 18
    }
  }
}
```

#### Steps

- [ ] **Step 1: Write the failing dashboard summary integration test**

Add this nested test inside the existing `test('Web Server /api/status and /api/logs endpoints', async (t) => { ... })` block in `test-suite.js`, after the `/api/logs` assertions and before the `finally`.

```js
    await t.test('GET /api/dashboard/summary returns command center state', async () => {
      const crossPost = require('./crossPost');
      const historySnapshot = utils.readJsonFileSecure(config.historyPath, []);
      const dlqSnapshot = utils.readJsonFileSecure(config.dlqPath, []);
      try {
        utils.writeJsonFileSecure(config.historyPath, [
          {
            sku: 'SUMMARY-ACTIVE',
            title: 'Active Sneakers',
            price: 99.99,
            status: 'ACTIVE',
            listingId: '12345',
            timestamp: '2026-07-02T10:00:00.000Z'
          },
          {
            sku: 'SUMMARY-DRAFT',
            title: 'Draft Jacket',
            price: 50,
            status: 'DRAFT',
            timestamp: '2026-07-02T11:00:00.000Z',
            veroWarning: true
          },
          {
            sku: 'SUMMARY-ENDED',
            title: 'Ended Camera',
            price: 25.5,
            status: 'ENDED',
            timestamp: '2026-07-02T09:00:00.000Z'
          }
        ]);
        utils.writeJsonFileSecure(config.dlqPath, []);
        await crossPost.addToDlq(
          'shopify',
          'SUMMARY-DLQ-SKU',
          {
            title: 'Queued Cross Post',
            suggestedPrice: 29.99,
            description: 'Cross-post summary test',
            brand: 'Generic',
            condition: 'USED_GOOD'
          },
          ['https://example.com/image.jpg'],
          'Simulated Shopify timeout'
        );

        const summaryRes = await fetch(`http://127.0.0.1:${testPort}/api/dashboard/summary`);
        assert.strictEqual(summaryRes.status, 200);
        const summary = await summaryRes.json();

        assert.strictEqual(summary.success, true);
        assert.ok(summary.generatedAt);
        assert.strictEqual(summary.readiness.diagnostics, 'OK');
        assert.strictEqual(summary.readiness.channels.ebay, summary.readiness.ebayAuthenticated);
        assert.strictEqual(summary.readiness.channels.gemini, true);
        assert.strictEqual(summary.readiness.channels.mercari, true);
        assert.strictEqual(summary.readiness.channels.poshmark, true);
        assert.strictEqual(summary.inventory.total, 3);
        assert.strictEqual(summary.inventory.active, 1);
        assert.strictEqual(summary.inventory.drafts, 1);
        assert.strictEqual(summary.inventory.ended, 1);
        assert.strictEqual(summary.inventory.totalValue, 175.49);
        assert.strictEqual(summary.inventory.veroWarnings, 1);
        assert.strictEqual(summary.inventory.latestDrafts.length, 1);
        assert.strictEqual(summary.inventory.latestDrafts[0].sku, 'SUMMARY-DRAFT');
        assert.strictEqual(summary.syncQueue.total, 1);
        assert.strictEqual(summary.syncQueue.ready, 1);
        assert.ok(summary.nextActions.some(action => action.id === 'process-sync-queue'));
        assert.ok(summary.nextActions.some(action => action.id === 'start-listing'));
        assert.ok(summary.system.uptimeSeconds >= 0);
      } finally {
        utils.writeJsonFileSecure(config.historyPath, historySnapshot);
        utils.writeJsonFileSecure(config.dlqPath, dlqSnapshot);
      }
    });
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
node --test --test-name-pattern "GET /api/dashboard/summary returns command center state" test-suite.js
```

Expected: FAIL with status `404` for `/api/dashboard/summary`.

- [ ] **Step 3: Add pure summary helpers to `webServer.js`**

Insert these helper functions after `getAuthenticatedUser(req)` and before `startWebGuiServer(port = 45900)`.

```js
function normalizeListingStatus(item) {
  return String(item?.status || 'ACTIVE').toUpperCase();
}

function buildInventorySummary(history = []) {
  const safeHistory = Array.isArray(history) ? history : [];
  const active = safeHistory.filter(item => normalizeListingStatus(item) === 'ACTIVE').length;
  const drafts = safeHistory.filter(item => normalizeListingStatus(item) === 'DRAFT').length;
  const ended = safeHistory.filter(item => normalizeListingStatus(item) === 'ENDED').length;
  const totalValue = Number(
    safeHistory.reduce((sum, item) => {
      const price = Number.parseFloat(item?.price);
      return Number.isFinite(price) ? sum + price : sum;
    }, 0).toFixed(2)
  );
  const latestDrafts = safeHistory
    .filter(item => normalizeListingStatus(item) === 'DRAFT')
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, 5)
    .map(item => ({
      sku: item.sku || '',
      title: item.title || 'Untitled draft',
      price: Number.parseFloat(item.price) || 0,
      timestamp: item.timestamp || null,
      veroWarning: !!item.veroWarning
    }));

  return {
    total: safeHistory.length,
    active,
    drafts,
    ended,
    totalValue,
    veroWarnings: safeHistory.filter(item => !!item.veroWarning).length,
    latestDrafts
  };
}

function buildNextActions(readiness, inventory, syncQueue) {
  const actions = [];
  if (!readiness.ebayAuthenticated) {
    actions.push({
      id: 'connect-ebay',
      label: 'Connect eBay',
      priority: 'high'
    });
  }
  if (!readiness.geminiConfigured) {
    actions.push({
      id: 'configure-gemini',
      label: 'Add Gemini key',
      priority: 'high'
    });
  }
  if ((syncQueue.ready || 0) > 0) {
    actions.push({
      id: 'process-sync-queue',
      label: 'Process ready sync jobs',
      priority: 'high'
    });
  }
  if ((syncQueue.exhausted || 0) > 0) {
    actions.push({
      id: 'review-exhausted-syncs',
      label: 'Review exhausted syncs',
      priority: 'high'
    });
  }
  if ((inventory.drafts || 0) > 0) {
    actions.push({
      id: 'review-drafts',
      label: 'Review drafts',
      priority: 'medium'
    });
  }
  actions.push({
    id: 'start-listing',
    label: 'Start new listing',
    priority: 'normal'
  });
  return actions;
}
```

- [ ] **Step 4: Add the `/api/dashboard/summary` route**

Insert this route in `webServer.js` after the existing `/api/status` route and before the `/api/metrics` route.

```js
    // API: Dashboard command center summary
    if (req.method === 'GET' && parsedUrl.pathname === '/api/dashboard/summary') {
      try {
        const circuitBreaker = ebayClient.getCircuitBreakerStatus();
        const diagnosticsOk = (() => {
          try {
            return config.runDiagnostics();
          } catch (e) {
            return false;
          }
        })();
        const readiness = {
          diagnostics: diagnosticsOk ? 'OK' : 'FAILED',
          ebayAuthenticated: !!ebayClient.getAccessToken(),
          geminiConfigured: !!config.getGEMINI_API_KEY(),
          circuitBreakerActive: !!circuitBreaker.active,
          channels: {
            ebay: !!ebayClient.getAccessToken(),
            gemini: !!config.getGEMINI_API_KEY(),
            shopify: !!(config.getSHOPIFY_SHOP_NAME() && config.getSHOPIFY_ACCESS_TOKEN()),
            woocommerce: !!(config.getWOOCOMMERCE_URL() && config.getWOOCOMMERCE_KEY() && config.getWOOCOMMERCE_SECRET()),
            etsy: !!(config.getETSY_SHOP_ID() && config.getETSY_ACCESS_TOKEN()),
            mercari: true,
            poshmark: true
          }
        };
        const history = utils.readJsonFileSecure(config.historyPath, []);
        const inventory = buildInventorySummary(history);
        const syncQueue = await crossPost.getDlqSummary();
        const memory = process.memoryUsage();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          generatedAt: new Date().toISOString(),
          readiness,
          inventory,
          syncQueue,
          nextActions: buildNextActions(readiness, inventory, syncQueue),
          system: {
            uptimeSeconds: Math.round(process.uptime()),
            totalRequests: metrics.totalRequests,
            activeSockets: activeSockets.size,
            memoryMb: {
              rss: Math.round(memory.rss / 1024 / 1024),
              heapUsed: Math.round(memory.heapUsed / 1024 / 1024)
            }
          }
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
```

- [ ] **Step 5: Run the focused test and confirm it passes**

Run:

```powershell
node --test --test-name-pattern "GET /api/dashboard/summary returns command center state" test-suite.js
```

Expected: PASS for the dashboard summary test.

- [ ] **Step 6: Run the full suite**

Run:

```powershell
node test-suite.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 1**

Run:

```powershell
git status --short
git add -- webServer.js test-suite.js
git commit -m "feat: add dashboard summary contract"
```

Expected: commit includes only `webServer.js` and `test-suite.js`.

---

### Task 2: Command Center Shell And Responsive Styles

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: no new JavaScript contract.
- Produces: DOM targets used by Task 3:
  - `#commandCenter`
  - `#ccUpdatedAt`
  - `#ccReadinessGrid`
  - `#ccInventoryGrid`
  - `#ccSyncGrid`
  - `#ccActions`
  - `#ccSystemMessage`

#### Steps

- [ ] **Step 1: Add static HTML structure**

In `public/index.html`, insert this section in the Create view immediately after the `section-header` block that contains the `New Listing` title and reset button.

```html
    <section class="command-center" id="commandCenter" aria-label="Seller command center">
      <div class="command-center__header">
        <div>
          <div class="command-center__eyebrow">Command Center</div>
          <h2 class="command-center__title">Today at a glance</h2>
        </div>
        <div class="command-center__meta">
          <span id="ccUpdatedAt">Waiting for status...</span>
          <button class="btn btn--ghost btn--xs" type="button" onclick="loadCommandCenter(true)">Refresh</button>
        </div>
      </div>

      <div class="command-center__grid">
        <div class="command-panel command-panel--wide">
          <div class="command-panel__label">Readiness</div>
          <div class="signal-grid" id="ccReadinessGrid" aria-live="polite">
            <span class="signal-pill signal-pill--muted">Loading...</span>
          </div>
        </div>

        <div class="command-panel">
          <div class="command-panel__label">Inventory</div>
          <div class="mini-metric-grid" id="ccInventoryGrid" aria-live="polite">
            <span class="mini-metric__empty">Loading...</span>
          </div>
        </div>

        <div class="command-panel">
          <div class="command-panel__label">Sync Queue</div>
          <div class="mini-metric-grid" id="ccSyncGrid" aria-live="polite">
            <span class="mini-metric__empty">Loading...</span>
          </div>
        </div>
      </div>

      <div class="command-center__footer">
        <div class="next-actions" id="ccActions" aria-label="Recommended actions">
          <button class="btn btn--primary btn--sm" type="button" onclick="runCommandAction('start-listing')">Start new listing</button>
        </div>
        <div class="command-center__message" id="ccSystemMessage" role="status">Checking system health...</div>
      </div>
    </section>
```

- [ ] **Step 2: Add command-center CSS**

Add this CSS near the existing dashboard/card styles and before the responsive media queries.

```css
    .command-center {
      margin-bottom: 18px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .command-center__header,
    .command-center__footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .command-center__eyebrow,
    .command-panel__label {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.64rem;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--text-dim);
    }
    .command-center__title {
      margin-top: 2px;
      font-family: 'Syne', sans-serif;
      font-size: 1.05rem;
      line-height: 1.2;
      font-weight: 700;
    }
    .command-center__meta {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-muted);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.72rem;
      text-align: right;
    }
    .command-center__grid {
      display: grid;
      grid-template-columns: minmax(260px, 1.15fr) minmax(180px, 0.85fr) minmax(180px, 0.85fr);
      gap: 12px;
      margin: 14px 0;
    }
    .command-panel {
      min-width: 0;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
    }
    .signal-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 10px;
    }
    .signal-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      background: rgba(255,255,255,0.025);
      font-size: 0.76rem;
      line-height: 1.2;
      white-space: normal;
    }
    .signal-pill::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--mist);
      flex: 0 0 auto;
    }
    .signal-pill--ok::before { background: var(--signal-green); }
    .signal-pill--warn::before { background: var(--amber); }
    .signal-pill--bad::before { background: var(--signal-red); }
    .signal-pill--muted::before { background: var(--mist); }
    .mini-metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .mini-metric {
      min-width: 0;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: rgba(0,0,0,0.12);
    }
    .mini-metric__value {
      display: block;
      overflow-wrap: anywhere;
      font-family: 'Syne', sans-serif;
      font-size: 1rem;
      font-weight: 700;
      line-height: 1.15;
    }
    .mini-metric__label,
    .mini-metric__empty {
      display: block;
      margin-top: 2px;
      color: var(--text-dim);
      font-size: 0.72rem;
      line-height: 1.25;
    }
    .next-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }
    .command-center__message {
      color: var(--text-muted);
      font-size: 0.78rem;
      text-align: right;
      line-height: 1.35;
    }

    @media (max-width: 1100px) {
      .command-center__grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 700px) {
      .command-center__header,
      .command-center__footer,
      .command-center__meta {
        align-items: stretch;
        flex-direction: column;
        text-align: left;
      }
      .mini-metric-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .next-actions .btn {
        flex: 1 1 150px;
      }
    }
```

- [ ] **Step 3: Run a static DOM target check**

Run:

```powershell
node -e "const fs=require('fs');const html=fs.readFileSync('public/index.html','utf8');for(const id of ['commandCenter','ccUpdatedAt','ccReadinessGrid','ccInventoryGrid','ccSyncGrid','ccActions','ccSystemMessage']){if(!html.includes('id=\"'+id+'\"')) throw new Error('missing '+id)};console.log('command center DOM targets found')"
```

Expected output:

```text
command center DOM targets found
```

- [ ] **Step 4: Commit Task 2**

Run:

```powershell
git status --short
git add -- public/index.html
git commit -m "feat: add command center shell"
```

Expected: commit includes only `public/index.html`.

---

### Task 3: Command Center Data Fetching And Rendering

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /api/dashboard/summary` from Task 1.
- Produces:
  - `loadCommandCenter(showErrors = false): Promise<void>`
  - `renderCommandCenter(summary: object): void`
  - `runCommandAction(actionId: string): void`

#### Steps

- [ ] **Step 1: Add command-center state and utility functions**

In the script section of `public/index.html`, place this block before the existing `pollApiStatus` function.

```js
  let commandCenterTimer = null;

  function formatMoney(value) {
    const amount = Number.parseFloat(value);
    if (!Number.isFinite(amount)) return '$0.00';
    return '$' + amount.toFixed(2);
  }

  function formatUpdatedAt(value) {
    if (!value) return 'Never refreshed';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Refresh time unavailable';
    return 'Updated ' + date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function renderSignal(label, ok, warn = false) {
    const cls = ok ? 'signal-pill--ok' : warn ? 'signal-pill--warn' : 'signal-pill--bad';
    return `<span class="signal-pill ${cls}">${escHtml(label)}</span>`;
  }

  function renderMiniMetric(value, label) {
    return `
      <span class="mini-metric">
        <span class="mini-metric__value">${escHtml(value)}</span>
        <span class="mini-metric__label">${escHtml(label)}</span>
      </span>`;
  }
```

- [ ] **Step 2: Add command-center rendering**

Place this block after the utility functions from Step 1.

```js
  function renderCommandActions(actions = []) {
    const target = document.getElementById('ccActions');
    if (!target) return;
    const ordered = [...actions].sort((a, b) => {
      const weight = { high: 0, medium: 1, normal: 2 };
      return (weight[a.priority] ?? 3) - (weight[b.priority] ?? 3);
    });
    target.innerHTML = ordered.map(action => {
      const cls = action.priority === 'high' ? 'btn--primary' : 'btn--secondary';
      return `<button class="btn ${cls} btn--sm" type="button" onclick="runCommandAction('${escHtml(action.id)}')">${escHtml(action.label)}</button>`;
    }).join('');
  }

  function renderCommandCenter(summary) {
    const readiness = summary.readiness || {};
    const channels = readiness.channels || {};
    const inventory = summary.inventory || {};
    const syncQueue = summary.syncQueue || {};
    const system = summary.system || {};

    const updatedAt = document.getElementById('ccUpdatedAt');
    if (updatedAt) updatedAt.textContent = formatUpdatedAt(summary.generatedAt);

    const readinessGrid = document.getElementById('ccReadinessGrid');
    if (readinessGrid) {
      readinessGrid.innerHTML = [
        renderSignal('Diagnostics ' + (readiness.diagnostics || 'UNKNOWN'), readiness.diagnostics === 'OK'),
        renderSignal('eBay', !!channels.ebay),
        renderSignal('Gemini', !!channels.gemini),
        renderSignal('Shopify', !!channels.shopify, true),
        renderSignal('WooCommerce', !!channels.woocommerce, true),
        renderSignal('Etsy', !!channels.etsy, true),
        renderSignal('Mercari export', !!channels.mercari),
        renderSignal('Poshmark export', !!channels.poshmark),
        renderSignal('Circuit breaker', !readiness.circuitBreakerActive, readiness.circuitBreakerActive)
      ].join('');
    }

    const inventoryGrid = document.getElementById('ccInventoryGrid');
    if (inventoryGrid) {
      inventoryGrid.innerHTML = [
        renderMiniMetric(String(inventory.total || 0), 'total items'),
        renderMiniMetric(formatMoney(inventory.totalValue || 0), 'listed value'),
        renderMiniMetric(String(inventory.active || 0), 'active'),
        renderMiniMetric(String(inventory.drafts || 0), 'drafts'),
        renderMiniMetric(String(inventory.ended || 0), 'ended'),
        renderMiniMetric(String(inventory.veroWarnings || 0), 'VeRO flags')
      ].join('');
    }

    const syncGrid = document.getElementById('ccSyncGrid');
    if (syncGrid) {
      syncGrid.innerHTML = [
        renderMiniMetric(String(syncQueue.total || 0), 'queued'),
        renderMiniMetric(String(syncQueue.ready || 0), 'ready'),
        renderMiniMetric(String(syncQueue.backingOff || 0), 'backing off'),
        renderMiniMetric(String(syncQueue.exhausted || 0), 'exhausted')
      ].join('');
    }

    renderCommandActions(summary.nextActions || []);

    const message = document.getElementById('ccSystemMessage');
    if (message) {
      message.textContent = `${system.totalRequests || 0} requests tracked · ${system.activeSockets || 0} active sockets · ${system.memoryMb?.heapUsed || 0} MB heap`;
    }
  }
```

- [ ] **Step 3: Add command-center loading and actions**

Place this block after `renderCommandCenter`.

```js
  async function loadCommandCenter(showErrors = false) {
    const message = document.getElementById('ccSystemMessage');
    try {
      const res = await fetch('/api/dashboard/summary');
      const summary = await res.json();
      if (!res.ok) throw new Error(summary.error || 'Unable to load dashboard summary');
      renderCommandCenter(summary);
      if (summary.syncQueue) updateDlqBadge(summary.syncQueue);
    } catch (err) {
      if (message) message.textContent = 'Command center unavailable: ' + err.message;
      if (showErrors) showToast('error', 'Command center unavailable', err.message, 5000);
    }
  }

  function runCommandAction(actionId) {
    switch (actionId) {
      case 'connect-ebay':
        openOnboardingWizard('ebay');
        break;
      case 'configure-gemini':
        openOnboardingWizard('ebay');
        showToast('info', 'Gemini setup', 'Add GEMINI_API_KEY in your .env file or run the bootstrap wizard.', 6000);
        break;
      case 'process-sync-queue':
      case 'review-exhausted-syncs':
        switchView('dlq');
        if (actionId === 'process-sync-queue') processDlqNow();
        break;
      case 'review-drafts':
        switchView('history');
        document.getElementById('historyStatusFilter').value = 'DRAFT';
        filterHistoryTable();
        break;
      case 'start-listing':
      default:
        switchView('create');
        document.getElementById('dropzone')?.focus();
        break;
    }
  }
```

- [ ] **Step 4: Hook refreshes into existing startup and mutations**

Replace the bottom startup block:

```js
  setInterval(pollApiStatus, 5000);
  pollApiStatus();
  loadDlqQueue(false);
  checkSession();
```

with:

```js
  setInterval(pollApiStatus, 5000);
  pollApiStatus();
  loadDlqQueue(false);
  loadCommandCenter(false);
  commandCenterTimer = setInterval(() => loadCommandCenter(false), 15000);
  checkSession();
```

Then add `loadCommandCenter(false);` after successful state-changing operations:

```js
      showToast('success','Sync complete','Listing database updated from eBay.',4000);
      loadHistory();
      loadCommandCenter(false);
```

```js
      renderDlqMetrics(data.summary || {});
      await loadDlqQueue(false);
      loadCommandCenter(false);
```

```js
      showToast('success', 'Draft saved', `SKU: ${data.sku}`, 4000);
      loadCommandCenter(false);
```

- [ ] **Step 5: Run static checks for function and ID usage**

Run:

```powershell
node -e "const fs=require('fs');const html=fs.readFileSync('public/index.html','utf8');for(const needle of ['function loadCommandCenter','function renderCommandCenter','function runCommandAction','/api/dashboard/summary','commandCenterTimer']){if(!html.includes(needle)) throw new Error('missing '+needle)};console.log('command center JavaScript targets found')"
```

Expected output:

```text
command center JavaScript targets found
```

- [ ] **Step 6: Run the full suite**

Run:

```powershell
node test-suite.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 3**

Run:

```powershell
git status --short
git add -- public/index.html
git commit -m "feat: render command center summary"
```

Expected: commit includes only `public/index.html`.

---

### Task 4: Safer Confirmation Modal For High-Risk Actions

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Produces: `confirmAction(options): Promise<boolean>`
- Produces: `promptAction(options): Promise<string|null>`
- Consumes: existing modal CSS classes and existing action functions.

#### Steps

- [ ] **Step 1: Add reusable confirm modal HTML**

Insert this modal after the existing `spruceModal` and before `onboardingModal`.

```html
<div class="modal-backdrop" id="actionConfirmModal" role="dialog" aria-modal="true" aria-labelledby="actionConfirmTitle">
  <div class="modal" style="max-width: 460px; width: 92%;">
    <div class="modal__header">
      <span class="modal__title" id="actionConfirmTitle">Confirm action</span>
      <button class="modal__close" type="button" onclick="resolveActionConfirm(false)" aria-label="Close">x</button>
    </div>
    <div class="modal__body">
      <p id="actionConfirmMessage" style="color: var(--text-muted); font-size: 0.9rem; line-height: 1.55;"></p>
      <div class="form-group" id="actionConfirmInputGroup" style="display:none; margin-top: 14px;">
        <div class="field-label"><label for="actionConfirmInput" id="actionConfirmInputLabel">Value</label></div>
        <input type="text" id="actionConfirmInput" autocomplete="off" />
      </div>
    </div>
    <div class="modal__footer">
      <button class="btn btn--secondary" type="button" onclick="resolveActionConfirm(false)">Cancel</button>
      <button class="btn btn--primary" type="button" id="actionConfirmPrimary" onclick="resolveActionConfirm(true)">Continue</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add modal control functions**

Place this JavaScript after `closeSpruceModal()` or near the other modal helpers.

```js
  let actionConfirmResolver = null;
  let actionConfirmMode = 'confirm';

  function openActionConfirm({ title, message, confirmLabel = 'Continue', danger = false, inputLabel = '', inputValue = '' }) {
    const modal = document.getElementById('actionConfirmModal');
    const titleEl = document.getElementById('actionConfirmTitle');
    const messageEl = document.getElementById('actionConfirmMessage');
    const primary = document.getElementById('actionConfirmPrimary');
    const inputGroup = document.getElementById('actionConfirmInputGroup');
    const input = document.getElementById('actionConfirmInput');
    const label = document.getElementById('actionConfirmInputLabel');

    titleEl.textContent = title;
    messageEl.textContent = message;
    primary.textContent = confirmLabel;
    primary.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
    inputGroup.style.display = inputLabel ? 'block' : 'none';
    label.textContent = inputLabel || 'Value';
    input.value = inputValue || '';
    modal.classList.add('open');
    setTimeout(() => (inputLabel ? input : primary).focus(), 0);
  }

  function resolveActionConfirm(accepted) {
    const modal = document.getElementById('actionConfirmModal');
    const input = document.getElementById('actionConfirmInput');
    modal.classList.remove('open');
    if (typeof actionConfirmResolver === 'function') {
      if (!accepted) actionConfirmResolver(actionConfirmMode === 'prompt' ? null : false);
      else actionConfirmResolver(actionConfirmMode === 'prompt' ? input.value.trim() : true);
    }
    actionConfirmResolver = null;
  }

  function confirmAction(options) {
    actionConfirmMode = 'confirm';
    openActionConfirm(options);
    return new Promise(resolve => {
      actionConfirmResolver = resolve;
    });
  }

  function promptAction(options) {
    actionConfirmMode = 'prompt';
    openActionConfirm(options);
    return new Promise(resolve => {
      actionConfirmResolver = resolve;
    });
  }
```

- [ ] **Step 3: Replace custom category prompts**

In `publishListing()` and `saveDraft()`, replace:

```js
      categoryId = prompt('Enter Custom eBay Category ID:') || '';
      if (!categoryId) { btn.disabled=false; btn.textContent='🚀 Publish to eBay'; return; }
```

with:

```js
      categoryId = await promptAction({
        title: 'Custom eBay category',
        message: 'Enter the numeric eBay category ID for this listing.',
        confirmLabel: 'Use Category',
        inputLabel: 'Category ID'
      }) || '';
      if (!categoryId) { btn.disabled=false; btn.textContent='Publish to eBay'; return; }
```

In `saveDraft()`, use this final button text on cancel:

```js
      if (!categoryId) { btn.disabled=false; btn.textContent='Save Draft'; return; }
```

- [ ] **Step 4: Replace high-risk confirms**

Replace each browser `confirm(...)` listed below with an awaited `confirmAction(...)`.

For publish duplicate or VeRO override:

```js
        if (await confirmAction({
          title: 'Publish anyway?',
          message: data.message + ' Publishing anyway may create a duplicate listing or trigger a marketplace policy issue.',
          confirmLabel: 'Publish Anyway',
          danger: true
        })) {
```

For save draft duplicate override:

```js
        if (await confirmAction({
          title: 'Save duplicate draft?',
          message: (data.message || 'A duplicate listing was detected.') + ' Saving anyway keeps a separate local draft.',
          confirmLabel: 'Save Draft',
          danger: false
        })) {
```

For `sendOffersToWatchers(sku)`:

```js
    if (!await confirmAction({
      title: 'Send watcher offer?',
      message: 'Send a 10% discount offer to all watchers for this listing.',
      confirmLabel: 'Send Offer'
    })) return;
```

For `publishDraft(sku)`:

```js
    if (!await confirmAction({
      title: 'Publish draft?',
      message: `Publish draft "${sku}" to eBay now.`,
      confirmLabel: 'Publish Draft'
    })) return;
```

For `endListing(sku, offerId)`:

```js
    if (!await confirmAction({
      title: 'End listing?',
      message: `End listing "${sku}". This is permanent on eBay.`,
      confirmLabel: 'End Listing',
      danger: true
    })) return;
```

For `deleteHistoryItem(sku)`:

```js
    if (!await confirmAction({
      title: 'Delete local record?',
      message: `Delete local record for SKU "${sku}". This does not end marketplace listings.`,
      confirmLabel: 'Delete Record',
      danger: true
    })) return;
```

For `dismissDlqJob(sku, platform)`:

```js
    if (!await confirmAction({
      title: 'Dismiss sync job?',
      message: `Remove ${sku} from the sync queue on ${platform}.`,
      confirmLabel: 'Dismiss Job'
    })) return;
```

For `clearDlqQueue()`:

```js
    if (!await confirmAction({
      title: 'Clear sync queue?',
      message: 'Clear every failed sync job from the queue. This cannot be undone.',
      confirmLabel: 'Clear Queue',
      danger: true
    })) return;
```

- [ ] **Step 5: Run static checks for removed browser dialogs**

Run:

```powershell
node -e "const fs=require('fs');const html=fs.readFileSync('public/index.html','utf8');for(const needle of ['function confirmAction','function promptAction','actionConfirmModal']){if(!html.includes(needle)) throw new Error('missing '+needle)};if(/confirm\\(|prompt\\(/.test(html)) throw new Error('browser confirm or prompt still present');console.log('custom confirmation modal wired')"
```

Expected output:

```text
custom confirmation modal wired
```

- [ ] **Step 6: Run the full suite**

Run:

```powershell
node test-suite.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit Task 4**

Run:

```powershell
git status --short
git add -- public/index.html
git commit -m "feat: improve dashboard action confirmations"
```

Expected: commit includes only `public/index.html`.

---

### Task 5: Documentation And Final Verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SETUP.md`
- Modify: `docs/ENVIRONMENT.md`
- Modify: `docs/TESTING_STRATEGY.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/QUICK_WINS.md`

**Interfaces:**
- Consumes: completed app behavior from Tasks 1-4.
- Produces: updated project documentation for setup, operation, and verification.

#### Steps

- [ ] **Step 1: Replace `docs/ARCHITECTURE.md`**

Use this content:

```markdown
# Architecture

## Overview

`ebay-lister-pro` is a CommonJS Node.js application with a vanilla HTML/CSS/JavaScript dashboard. `webServer.js` serves the dashboard and API routes. `simple-lister-pro.js` runs the folder watcher and interactive listing workflow. Marketplace and AI integrations live in focused modules:

- `ebayClient.js`: eBay auth, inventory, offers, policies, comps, repricing, VeRO helpers.
- `geminiClient.js`: Gemini Vision listing generation and schema repair.
- `crossPost.js`: Shopify, WooCommerce, Etsy cross-posting and dead-letter queue retries.
- `utils.js`: JSON persistence, audit logs, image validation, optimization, and shared helpers.

## Command Center Flow

The dashboard loads `GET /api/dashboard/summary` to render readiness, inventory, sync queue, next actions, and lightweight system status. The endpoint derives inventory from `data/listings-history.json`, retry state from `data/pending-syncs.json`, auth readiness from configured environment variables, and runtime counters from the in-memory web server metrics.

## Data Flow

1. Product photos enter through upload, URL import, Chrome extension draft save, or the watcher daemon.
2. `/api/analyze` materializes images, calls Gemini, gets eBay category/comps data, and returns a draft listing.
3. `/api/save-draft` writes draft state to JSON history.
4. `/api/publish` publishes to eBay and optionally cross-posts to Shopify, WooCommerce, and Etsy.
5. Failed cross-posts are stored in the DLQ and surfaced in the dashboard sync queue.
6. `/api/dashboard/summary` composes history, channel readiness, metrics, and DLQ state for the command center.
```

- [ ] **Step 2: Replace `docs/SETUP.md`**

Use this content:

```markdown
# Setup

## Prerequisites

- Node.js 18 or newer.
- eBay developer app credentials and seller refresh token for publishing.
- Google Gemini API key for AI listing generation.
- Optional Shopify, WooCommerce, Etsy, Google OAuth, and Stripe credentials.

## Installation

```powershell
npm install
node bootstrap.js
```

The bootstrap wizard creates or updates `.env`. Use `.env.example` as the reference for every supported variable.

## First Run

```powershell
node start.js
```

Open the dashboard at `http://127.0.0.1:45911`.

## Command Center Smoke Check

1. Confirm the command center appears above the listing workspace.
2. Confirm readiness pills show eBay, Gemini, Shopify, WooCommerce, Etsy, Mercari export, and Poshmark export.
3. Open Listing History and Sync Queue from the command-center actions or sidebar.
4. Run `node test-suite.js` before shipping changes.
```

- [ ] **Step 3: Replace `docs/ENVIRONMENT.md`**

Use this content:

```markdown
# Environment

## Variables

| Name | Required | Description |
| --- | --- | --- |
| API_KEY | Yes | Local API key used by the Chrome extension and local dashboard integrations. |
| GEMINI_API_KEY | Yes for AI | Google Gemini key used for image analysis and listing generation. |
| GOOGLE_CLIENT_ID | No | Enables Google Sign-In when set. |
| GOOGLE_CLIENT_SECRET | No | Secret for Google OAuth callback exchange. |
| GOOGLE_REDIRECT_URI | No | OAuth callback URL, default `http://localhost:45911/api/auth/google/callback`. |
| STRIPE_SECRET_KEY | No | Enables Stripe checkout session creation. |
| STRIPE_WEBHOOK_SECRET | No | Validates Stripe billing webhooks. |
| EBAY_CLIENT_ID | Yes for eBay | eBay application client ID. |
| EBAY_CLIENT_SECRET | Yes for eBay | eBay application client secret. |
| EBAY_REFRESH_TOKEN | Yes for eBay | Seller refresh token used to mint access tokens. |
| EBAY_LOCATION_KEY | No | Inventory location key, default `default`. |
| EBAY_FULFILLMENT_POLICY_ID | No | Existing eBay fulfillment policy override. |
| EBAY_PAYMENT_POLICY_ID | No | Existing eBay payment policy override. |
| EBAY_RETURN_POLICY_ID | No | Existing eBay return policy override. |
| SHOPIFY_SHOP_NAME | No | Shopify shop subdomain for cross-posting. |
| SHOPIFY_ACCESS_TOKEN | No | Shopify Admin API access token. |
| WOOCOMMERCE_URL | No | WooCommerce store URL. |
| WOOCOMMERCE_KEY | No | WooCommerce REST consumer key. |
| WOOCOMMERCE_SECRET | No | WooCommerce REST consumer secret. |
| ETSY_SHOP_ID | No | Etsy shop ID for cross-posting. |
| ETSY_ACCESS_TOKEN | No | Etsy OAuth access token. |
| ETSY_CLIENT_ID | No | Etsy Open API key. |
| WATERMARK_TEXT | No | Text used by image sprucing watermark options. |
| SKU_PREFIX | No | Prefix for generated SKUs, default `AUTO-`. |
| DEFAULT_PRICING_STRATEGY | No | Pricing strategy used by automated flows, default `MARKET`. |
| DEFAULT_SHIPPING_OPTION | No | Shipping preset, default `USPS_GROUND`. |
| DEFAULT_RETURN_OPTION | No | Return preset, default `NO_RETURNS`. |
| DEFAULT_IMMEDIATE_PAYMENT | No | Immediate payment default, true unless set to `false`. |
| SELLER_SHIPPING_TERMS | No | Seller terms appended to eBay descriptions. |
| SELLER_RETURN_TERMS | No | Return terms appended to eBay descriptions. |

## Local Services

The app stores local runtime state in `data/`:

- `data/listings-history.json`
- `data/pending-syncs.json`
- `data/lister-audit.log`
- `data/uploads/`
```

- [ ] **Step 4: Replace `docs/TESTING_STRATEGY.md`**

Use this content:

```markdown
# Testing Strategy

## Automated

Run the full native test suite:

```powershell
node test-suite.js
```

The suite covers config loading, secure JSON storage, image validation, eBay retry/auth behavior, Gemini schema repair, web routes, OAuth/billing, repricing, cross-posting, DLQ behavior, image sprucing, and command-center summary state.

## Focused Checks

Use Node's test-name filter while developing a focused backend route:

```powershell
node --test --test-name-pattern "GET /api/dashboard/summary returns command center state" test-suite.js
```

## Manual Smoke

1. Start the app with `node start.js`.
2. Open `http://127.0.0.1:45911`.
3. Confirm the command center renders readiness, inventory, sync queue, actions, and system message.
4. Upload or import images and run AI analysis.
5. Save a draft and confirm inventory counts refresh.
6. Open Listing History, run Sync from eBay, and confirm command-center counts refresh.
7. Open Sync Queue and verify retry, dismiss, process, and clear confirmations.
8. Resize to mobile width and confirm buttons, cards, and table actions do not overlap.
```

- [ ] **Step 5: Replace `docs/ROADMAP.md`**

Use this content:

```markdown
# Roadmap

## Now

- Ship the command center dashboard.
- Improve high-risk action confirmations.
- Keep backend summary contracts covered by native tests.

## Next

- Extract frontend JavaScript into smaller files once CSP/static serving is adjusted.
- Add browser-level smoke tests for desktop and mobile dashboard flows.
- Expand setup diagnostics for missing credentials and marketplace policy readiness.

## Later

- Consider database-backed persistence for multi-user deployments.
- Consider background job visibility for watcher and cross-post queues.
- Revisit auth and billing flows for production SaaS packaging.
```

- [ ] **Step 6: Replace `docs/QUICK_WINS.md`**

Use this content:

```markdown
# Quick Wins

Use this as a parking lot for small, high-leverage improvements.

| Win | Impact | Effort | Status |
| --- | --- | --- | --- |
| Improve setup docs | Medium | Small | Done |
| Add command-center smoke screenshots | Medium | Small | Open |
| Extract dashboard helper functions | High | Medium | Open |
| Add browser-level responsive checks | High | Medium | Open |
```

- [ ] **Step 7: Run documentation sanity checks**

Run:

```powershell
node -e "const fs=require('fs');for(const f of ['docs/ARCHITECTURE.md','docs/SETUP.md','docs/ENVIRONMENT.md','docs/TESTING_STRATEGY.md','docs/ROADMAP.md','docs/QUICK_WINS.md']){const s=fs.readFileSync(f,'utf8');if(/TBD|TODO|EXAMPLE_VAR|Add .* here/.test(s)) throw new Error('placeholder remains in '+f)};console.log('docs sanity check passed')"
```

Expected output:

```text
docs sanity check passed
```

- [ ] **Step 8: Run full verification**

Run:

```powershell
node test-suite.js
```

Expected: all tests pass.

Manual smoke:

```text
Start: node start.js
Open: http://127.0.0.1:45911
Check: command center visible, no overlapping controls at desktop and mobile widths, history and DLQ actions still work.
```

- [ ] **Step 9: Commit Task 5**

Run:

```powershell
git status --short
git add -- docs/ARCHITECTURE.md docs/SETUP.md docs/ENVIRONMENT.md docs/TESTING_STRATEGY.md docs/ROADMAP.md docs/QUICK_WINS.md
git commit -m "docs: document command center operations"
```

Expected: commit includes only the six docs files.

