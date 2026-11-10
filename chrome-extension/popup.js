// Chrome Extension Popup Script
// [ATLAS-R4] Settings live in chrome.storage.local — never in source. The
// previous build hardcoded the server's old publicly-known default API key
// and a stale port (45911 vs the server's 45900 default), which both broke
// the extension against a hardened server and taught an insecure setup.
// The operator copies API_KEY from their own server .env into Settings.
const DEFAULT_API_URL = "http://127.0.0.1:45900";
let API_URL = DEFAULT_API_URL;
let API_KEY = "";

let scrapedImages = [];

document.addEventListener("DOMContentLoaded", async () => {
  // 0. Load operator settings (server URL + API key) before any request.
  try {
    const saved = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    if (saved.apiUrl) API_URL = String(saved.apiUrl).replace(/\/+$/, "");
    if (saved.apiKey) API_KEY = String(saved.apiKey);
  } catch (e) { /* storage unavailable — defaults apply */ }
  const serverUrlInput = document.getElementById("serverUrl");
  const apiKeyInput = document.getElementById("apiKey");
  if (serverUrlInput) serverUrlInput.value = API_URL;
  if (apiKeyInput) apiKeyInput.value = API_KEY;
  const persistSettings = async () => {
    API_URL = (serverUrlInput.value.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
    API_KEY = apiKeyInput.value.trim();
    try { await chrome.storage.local.set({ apiUrl: API_URL, apiKey: API_KEY }); } catch (e) {}
  };
  if (serverUrlInput) serverUrlInput.addEventListener("change", persistSettings);
  if (apiKeyInput) apiKeyInput.addEventListener("change", persistSettings);

  const titleInput = document.getElementById("title");
  const priceInput = document.getElementById("price");
  const brandInput = document.getElementById("brand");
  const descInput = document.getElementById("description");
  const imageCountEl = document.getElementById("imageCount");
  const serverStatusEl = document.getElementById("serverStatus");
  const sendBtn = document.getElementById("sendBtn");
  const statusDiv = document.getElementById("status");

  function showStatus(msg, type) {
    statusDiv.innerText = msg;
    statusDiv.className = type;
    statusDiv.style.display = "block";
  }

  // 1. Check if local Lister server is online
  try {
    const statusRes = await fetch(`${API_URL}/api/status`);
    if (statusRes.ok) {
      serverStatusEl.innerText = "Local Server: Online";
      serverStatusEl.style.color = "#10b981";
    } else {
      throw new Error();
    }
  } catch (e) {
    serverStatusEl.innerText = "Local Server: Offline";
    serverStatusEl.style.color = "#ef4444";
    showStatus("Lister server offline. Launch it via 'node webServer.js'", "error");
  }

  // 2. Request data from content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    
    chrome.tabs.sendMessage(tabs[0].id, { action: "scrapeProduct" }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus("Could not scrap this tab. Reload page and try again.", "error");
        return;
      }
      
      if (response && response.success) {
        const item = response.data;
        titleInput.value = item.title;
        priceInput.value = item.suggestedPrice.toFixed(2);
        brandInput.value = item.brand;
        descInput.value = item.description;
        scrapedImages = item.imageUrls;
        imageCountEl.innerText = `Images Found: ${scrapedImages.length}`;
      } else {
        showStatus("Scraping failed: " + (response ? response.error : "Unknown error"), "error");
      }
    });
  });

  // 3. Send draft payload to local webServer API
  sendBtn.addEventListener("click", async () => {
    if (!API_KEY) {
      showStatus("Set your operator API key first (Extension Settings below — the API_KEY value from your server .env).", "error");
      return;
    }
    showStatus("Sending draft...", "success");
    const payload = {
      listing: {
        title: titleInput.value,
        description: descInput.value,
        suggestedPrice: parseFloat(priceInput.value) || 9.99,
        brand: brandInput.value || "Generic",
        model: "Does Not Apply",
        condition: "USED_EXCELLENT",
        aspects: {}
      },
      imageUrls: scrapedImages
    };

    try {
      const res = await fetch(`${API_URL}/api/save-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lister-API-Key": API_KEY
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      showStatus(`Draft Saved! SKU: ${data.sku}`, "success");
    } catch (err) {
      showStatus("Failed to save draft: " + err.message, "error");
    }
  });
});
