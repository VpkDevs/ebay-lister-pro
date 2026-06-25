// Chrome Extension Content Script for scraping listing data
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "scrapeProduct") {
    try {
      const hostname = window.location.hostname;
      let productData = {
        title: "",
        description: "",
        suggestedPrice: 9.99,
        imageUrls: [],
        barcode: "",
        brand: "Generic",
        model: "Does Not Apply"
      };

      if (hostname.includes("amazon.com")) {
        // Scrape Amazon
        const titleEl = document.getElementById("productTitle");
        if (titleEl) productData.title = titleEl.innerText.trim();

        // Price
        const priceEl = document.querySelector(".a-price .a-offscreen") || document.querySelector("#priceblock_ourprice") || document.querySelector("#priceblock_dealprice");
        if (priceEl) {
          const val = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, ""));
          if (!isNaN(val)) productData.suggestedPrice = val;
        }

        // Description
        const bulletsEl = document.getElementById("feature-bullets");
        const descEl = document.getElementById("productDescription");
        let descText = "";
        if (bulletsEl) descText += "Key Features:\n" + bulletsEl.innerText.trim() + "\n\n";
        if (descEl) descText += descEl.innerText.trim();
        productData.description = descText.trim();

        // Images
        const imgEl = document.getElementById("landingImage") || document.getElementById("main-image");
        if (imgEl) {
          try {
            const dataObj = JSON.parse(imgEl.getAttribute("data-a-dynamic-image") || "{}");
            productData.imageUrls = Object.keys(dataObj);
          } catch (e) {
            if (imgEl.src) productData.imageUrls.push(imgEl.src);
          }
        }
        
        // Try to scrape Brand
        const brandEl = document.querySelector("#bylineInfo") || document.querySelector(".brand-link");
        if (brandEl) {
          productData.brand = brandEl.innerText.replace(/Visit the\s+/i, "").replace(/\s+Store/i, "").trim();
        }

      } else if (hostname.includes("ebay.com")) {
        // Scrape eBay
        const titleEl = document.querySelector(".x-item-title__mainTitle") || document.querySelector("#itemTitle");
        if (titleEl) {
          productData.title = titleEl.innerText.replace(/Details about\s+/i, "").trim();
        }

        const priceEl = document.querySelector(".x-price-primary") || document.querySelector("#prcIsum");
        if (priceEl) {
          const val = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, ""));
          if (!isNaN(val)) productData.suggestedPrice = val;
        }

        const descDiv = document.querySelector("#desc_div") || document.querySelector("#vi-desc-maincntr");
        if (descDiv) productData.description = descDiv.innerText.trim();

        // Scrape Images
        const imgEls = document.querySelectorAll(".ux-image-filmstrip-carousell-item img, .ux-image-carousel-item img, #vi_main_img_fs img");
        imgEls.forEach(img => {
          let src = img.getAttribute("data-zoom-src") || img.getAttribute("src") || img.getAttribute("data-src");
          if (src && !src.includes("icon") && !productData.imageUrls.includes(src)) {
            productData.imageUrls.push(src);
          }
        });

      } else if (hostname.includes("poshmark.com")) {
        // Scrape Poshmark
        const titleEl = document.querySelector(".pdp__title") || document.querySelector("h1");
        if (titleEl) productData.title = titleEl.innerText.trim();

        const priceEl = document.querySelector(".pdp__price") || document.querySelector(".price");
        if (priceEl) {
          const val = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, ""));
          if (!isNaN(val)) productData.suggestedPrice = val;
        }

        const descEl = document.querySelector(".pdp__description-text") || document.querySelector(".listing-description");
        if (descEl) productData.description = descEl.innerText.trim();

        // Images
        const imgEls = document.querySelectorAll(".pdp__img-container img, .slideshow__slide img");
        imgEls.forEach(img => {
          if (img.src && !productData.imageUrls.includes(img.src)) {
            productData.imageUrls.push(img.src);
          }
        });

      } else if (hostname.includes("mercari.com")) {
        // Scrape Mercari
        const titleEl = document.querySelector("[class*='Header'] h1") || document.querySelector("h1");
        if (titleEl) productData.title = titleEl.innerText.trim();

        const priceEl = document.querySelector("[class*='PriceText']") || document.querySelector("[data-testid='ItemPrice']");
        if (priceEl) {
          const val = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, ""));
          if (!isNaN(val)) productData.suggestedPrice = val;
        }

        const descEl = document.querySelector("[class*='Description']") || document.querySelector("[data-testid='ItemDescription']");
        if (descEl) productData.description = descEl.innerText.trim();

        // Images
        const imgEls = document.querySelectorAll("[class*='Thumbnail'] img, [data-testid='ItemPhoto'] img");
        imgEls.forEach(img => {
          if (img.src && !productData.imageUrls.includes(img.src)) {
            productData.imageUrls.push(img.src);
          }
        });

      } else {
        // Generic Shopify or other webstore
        const titleEl = document.querySelector("h1, title");
        if (titleEl) productData.title = titleEl.innerText.trim();

        const priceEl = document.querySelector("[class*='price'], .price, #Price");
        if (priceEl) {
          const val = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, ""));
          if (!isNaN(val)) productData.suggestedPrice = val;
        }
      }

      // Filter and clean imageUrls
      productData.imageUrls = productData.imageUrls.filter(url => url.startsWith("http"));

      sendResponse({ success: true, data: productData });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }
  return true; // keep channel open for async response
});
