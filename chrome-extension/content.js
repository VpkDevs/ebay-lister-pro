// Onboarding overlay injection
(function() {
  const url = window.location.href;
  let steps = [];
  let title = "";

  if (url.includes("developer.ebay.com")) {
    title = "eBay App Credentials Guide";
    steps = [
      "Sign in or register a developer account.",
      "Navigate to 'Application Keys' dashboard.",
      "Under 'Production', click 'Create a keyset'.",
      "Copy the App ID (Client ID) and Cert ID (Client Secret).",
      "Paste them into your Lister Pro Setup Wizard."
    ];
  } else if (url.includes("shopify.com/admin/settings/apps/development")) {
    title = "Shopify Admin API Token Guide";
    steps = [
      "Click the 'Create an app' button in the top right.",
      "Name it 'Lister Pro' and configure API scopes.",
      "Check write_products, read_products, write_inventory, read_inventory.",
      "Click 'Install app' and copy the token starting with 'shpat_'."
    ];
  } else if (url.includes("wp-admin/admin.php") && url.includes("wc-settings") && url.includes("keys")) {
    title = "WooCommerce REST API Guide";
    steps = [
      "Click 'Add Key' button.",
      "Enter Description (e.g. 'Lister Pro').",
      "Set Permissions to 'Read/Write'.",
      "Click 'Generate API Key'.",
      "Copy Consumer Key (ck_...) and Consumer Secret (cs_...)."
    ];
  } else if (url.includes("etsy.com/developers")) {
    title = "Etsy Developer App Guide";
    steps = [
      "Sign in and click 'Register a new application'.",
      "Fill out the name and select 'Seller Integration'.",
      "Copy the API Keystring (Client ID) and Shop ID."
    ];
  }

  if (steps.length > 0) {
    // Render visual guided popup box
    const card = document.createElement("div");
    card.id = "lister-pro-guide-overlay";
    card.style.position = "fixed";
    card.style.bottom = "20px";
    card.style.right = "20px";
    card.style.width = "320px";
    card.style.backgroundColor = "#18181b";
    card.style.color = "#f4f4f5";
    card.style.border = "2px solid #fbbf24";
    card.style.borderRadius = "8px";
    card.style.padding = "16px";
    card.style.boxShadow = "0 10px 15px -3px rgba(0, 0, 0, 0.5)";
    card.style.zIndex = "999999";
    card.style.fontFamily = "system-ui, -apple-system, sans-serif";
    card.style.fontSize = "13px";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.borderBottom = "1px solid #3f3f46";
    header.style.paddingBottom = "8px";
    header.style.marginBottom = "10px";

    const titleSpan = document.createElement("span");
    titleSpan.innerText = "⚡ " + title;
    titleSpan.style.fontWeight = "bold";
    titleSpan.style.color = "#fbbf24";

    const closeBtn = document.createElement("button");
    closeBtn.innerText = "×";
    closeBtn.style.background = "none";
    closeBtn.style.border = "none";
    closeBtn.style.color = "#a1a1aa";
    closeBtn.style.fontSize = "18px";
    closeBtn.style.cursor = "pointer";
    closeBtn.onclick = () => card.remove();

    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    card.appendChild(header);

    const list = document.createElement("ol");
    list.style.margin = "0";
    list.style.paddingLeft = "18px";
    list.style.lineHeight = "1.6";

    steps.forEach(stepText => {
      const li = document.createElement("li");
      li.innerText = stepText;
      li.style.marginBottom = "6px";
      list.appendChild(li);
    });

    card.appendChild(list);

    const footer = document.createElement("div");
    footer.style.marginTop = "12px";
    footer.style.fontSize = "11px";
    footer.style.color = "#a1a1aa";
    footer.innerText = "Once keys are generated, paste them into Lister Pro.";
    card.appendChild(footer);

    document.body.appendChild(card);
  }
})();

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
