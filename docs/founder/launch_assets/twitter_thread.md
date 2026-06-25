# Twitter Thread Launch Assets — eBay Multi-Channel Lister Pro

---

## 🐦 Twitter Thread

### Tweet 1 (Hook)
> I got tired of paying $50/month for cross-listing apps that lag and bloat my machine.
> 
> So, I spent the last few weeks building my own: a 100% zero-dependency, local-first lister that posts to eBay, Shopify, WooCommerce & Etsy in 90 seconds.
> 
> Here's the story of how I did it: 🧵👇

### Tweet 2
> First rule: Zero external dependencies.
> 
> No Express. No SQLite drivers. No UI frameworks. No npm install bloat.
> 
> I wrote the server, CORS, session auth, rate-limiters, and file-locking database completely from scratch using native Node.js core modules.
> 
> Boots in under 10ms. ⚡

### Tweet 3
> Next, I wanted hands-off listing enrichment.
> 
> Integrated Google Gemini Vision AI. You drop a photo, and the AI:
> 1. Detects defects (scuffs, stains)
> 2. Suggests precise item conditions
> 3. Extracts brand, model, and UPC barcodes
> 
> All processed locally in seconds.

### Tweet 4
> Pricing comps are tricky. I wrote a native outlier filter that queries the eBay API, ignores extreme prices, and calculates realistic averages using the Interquartile Range (IQR).
> 
> Accurate pricing, automatically. 📈

### Tweet 5
> Watermarking and image edits usually require heavy libraries.
> 
> Instead, I wrote a PowerShell script using GDI+ that crops, squares, and watermarks photos natively on Windows, spawned from the Node process. No extra software needed. 📸

### Tweet 6
> Best part? Double-selling protection.
> 
> The background daemon monitors active listings. If an item sells on eBay, it immediately archives it on Shopify and WooCommerce to prevent inventory mismatches.
> 
> Standard circuit breakers isolate network faults.

### Tweet 7 (The Ask)
> Lister Pro is fully open-source and free to self-host.
> 
> You can run it locally with a single command: `node start.js`.
> 
> Check out the GitHub repo and try it out: [Link]
> 
> RTs or feedback on the pricing comp engine are highly appreciated! 🙏
