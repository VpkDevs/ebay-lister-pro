# Reddit r/flipping Launch Assets — eBay Multi-Channel Lister Pro

---

## 1. Post Details

- **Subreddit**: r/flipping
- **Title**: I got tired of paying $50/mo for cross-listing software, so I built a zero-dependency local lister
- **Flair**: Discussion / Tool

---

## 2. Post Body Copy

```markdown
Hey everyone,

I’ve been flipping on eBay and Shopify for a couple of years. One of my biggest pain points has always been cross-listing. It takes forever, and the popular apps (like Vendoo or Crosslist) charge a hefty monthly subscription that cuts straight into my profit margins.

So, I decided to build my own local lister. I had a few rules:
1. It had to be 100% free and self-hostable.
2. It had to be zero-dependency (so no weird node_modules folders or vulnerabilities).
3. It had to be fast.

### What it does:
- Image sprucing: Automatically crops, squares, and watermarks your photos natively.
- Gemini Vision: Uses Google's AI to look at your listing photos, find defects (scuffs, stains), suggest item conditions, extract model details, and find the UPC.
- Comp Lookup: Searches active eBay listings and calculates the average market price, excluding statistical outliers.
- Multi-Channel Sync: Cross-posts to eBay, Shopify, WooCommerce, and Etsy concurrently.
- Double-Sell Protection: Periodically checks active listings. If an item sells on eBay, it automatically archives the product on Shopify (and vice versa) to prevent double-selling.

It runs locally on your machine and serves a clean dark-mode dashboard at `http://localhost:45900`. 

It's completely open. I’ve put the code up on GitHub so anyone can clone it and run it for free.

If anyone wants to try it, I'd love to hear your feedback on the pricingcomp calculations or the layout!
```
