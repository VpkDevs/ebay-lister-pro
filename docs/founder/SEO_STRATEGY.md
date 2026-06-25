# SEO Strategy — eBay Multi-Channel Lister Pro

This document specifies the technical and content-level SEO optimization plan for the Lister Pro landing and documentation pages.

---

## 🛠️ Technical SEO Specifications

### 1. Title Tags & Meta Descriptions

Every page must serve optimized title and description tags:

| Page | Title Tag (`<title>`) | Meta Description (`name="description"`) |
|---|---|---|
| **Landing** | Lister Pro | Multi-channel eBay, Shopify & Etsy lister. |
| **Terms** | Terms of Service | Terms of Service |
| **Privacy** | Privacy Policy | Privacy Policy |

### 2. Robots & Sitemap
- **sitemap.xml**: Dynamically generated to index `/`, `/terms`, `/privacy`, `/press`.
- **robots.txt**: Sane defaults allowing all major search engine crawlers:
  ```text
  User-agent: *
  Allow: /
  Sitemap: https://ebaylisterpro.com/sitemap.xml
  ```

### 3. Canonical URLs
Every page must declare a canonical link in its head to prevent duplicate content flags:
```html
<link rel="canonical" href="https://ebaylisterpro.com/landing" />
```

---

## 📊 Structured Schema Data (JSON-LD)

To capture Google rich snippets, embed this JSON-LD schema in the head of the landing page:

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "eBay Multi-Channel Lister Pro",
  "operatingSystem": "Windows, macOS, Linux",
  "applicationCategory": "BusinessApplication",
  "offers": {
    "@type": "Offer",
    "price": "29.00",
    "priceCurrency": "USD"
  },
  "description": "Zero-dependency desktop cross-listing software for eBay, Shopify, WooCommerce, and Etsy."
}
```
