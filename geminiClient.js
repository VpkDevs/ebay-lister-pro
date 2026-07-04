/**
 * @file geminiClient.js
 * @description Interfaces with the Google Gemini API to analyze product photos and generate optimized eBay listings.
 */

const fs = require('fs');
const config = require('./config');
const utils = require('./utils');
const ebayClient = require('./ebayClient');

/**
 * Retrieves up to 3 similar past listings from local history to act as few-shot style examples.
 * @param {string} draftTitle - The temporary draft title from Pass 1.
 * @param {number} [limit=3] - Max examples.
 * @returns {string} Formatted text block with style examples.
 */
function getSimilarListingsFromHistory(draftTitle, limit = 3) {
  try {
    const historyPath = config.historyPath;
    if (!fs.existsSync(historyPath)) return "";
    const history = utils.readJsonFileSecure(historyPath, []);
    if (history.length === 0) return "";

    const draftTokens = String(draftTitle || '').toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 2 && !['and', 'the', 'for', 'with', 'new', 'used'].includes(t));

    if (draftTokens.length === 0) return "";

    const scored = history.map(item => {
      let score = 0;
      if (item.title) {
        const itemTokens = item.title.toLowerCase().split(/\s+/);
        for (const token of draftTokens) {
          if (itemTokens.includes(token)) score++;
        }
      }
      return { item, score };
    }).filter(x => x.score > 0);

    const topExamples = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.item);

    if (topExamples.length === 0) return "";

    let styleCloningPrompt = "\nHere are examples of past successful listings in this store. Match their tone, level of detail, formatting style, and aspect key naming conventions:\n";
    topExamples.forEach((ex, idx) => {
      const descriptionText = ex.listingDetails?.description || ex.description || "";
      const cleanDesc = descriptionText.replace(/<[^>]*>/g, '').slice(0, 300).trim();
      styleCloningPrompt += `Example ${idx + 1}:\n- Title: ${ex.title}\n- Aspects: ${JSON.stringify(ex.listingDetails?.aspects || ex.aspects || {})}\n- Description: ${cleanDesc}\n\n`;
    });
    return styleCloningPrompt;
  } catch (err) {
    utils.logAudit("WARN", `Failed to build style cloning prompt from history: ${err.message}`);
    return "";
  }
}

/**
 * Runs the Gemini AI orchestration to generate listing details based on product photos and metadata.
 * @param {Buffer[]} photoBuffers - Array of image file buffers.
 * @param {string[]} filenames - Array of image filenames matching the buffers.
 * @param {string|null} [barcode] - Optional barcode or UPC number.
 * @param {string|null} [customNotes] - Optional custom notes/instructions from user.
 * @param {object|null} [upcData] - Optional verified catalog details from eBay catalog.
 * @param {object} [options={}] - Persona and styling template choices.
 * @returns {Promise<object>} The validated and formatted listing object.
 * @throws {Error} If parameters are invalid or Gemini API call fails.
 */
async function runAIOrchestration(photoBuffers, filenames, barcode = null, customNotes = null, upcData = null, options = {}) {
  // Parameter validation
  if (!Array.isArray(photoBuffers) || photoBuffers.length === 0) {
    throw new Error("Validation Error: photoBuffers must be a non-empty array of Buffers.");
  }
  for (const buf of photoBuffers) {
    if (!Buffer.isBuffer(buf)) {
      throw new Error("Validation Error: elements of photoBuffers must be Node.js Buffer instances.");
    }
  }
  if (!Array.isArray(filenames) || filenames.length !== photoBuffers.length) {
    throw new Error("Validation Error: filenames must be an array of matching length to photoBuffers.");
  }
  if (barcode !== null && typeof barcode !== 'string') {
    throw new Error("Validation Error: barcode must be a string or null.");
  }
  if (customNotes !== null && typeof customNotes !== 'string') {
    throw new Error("Validation Error: customNotes must be a string or null.");
  }
  if (upcData !== null && typeof upcData !== 'object') {
    throw new Error("Validation Error: upcData must be an object or null.");
  }

  const geminiKey = config.getGEMINI_API_KEY();
  if (!geminiKey) {
    throw new Error("GEMINI_API_KEY is not defined in your environment or .env file.");
  }
  if (geminiKey === "your_gemini_api_key_here") {
    throw new Error("GEMINI_API_KEY is not configured. Please run 'node bootstrap.js' or set the GEMINI_API_KEY in your .env file to your actual Google AI Studio API key.");
  }

  const imageParts = photoBuffers.map((buffer, index) => {
    const filename = filenames[index] || 'image.jpg';
    let mimeType = 'image/jpeg';
    if (filename.toLowerCase().endsWith('.png')) {
      mimeType = 'image/png';
    }
    return {
      inlineData: { mimeType, data: buffer.toString("base64") }
    };
  });
  
  let pass1Prompt = `
    Analyze these product photo(s). Check all images to see if there is a visible product barcode or UPC number.
    If you find a barcode, extract its numeric digits.
    Also, scan the image(s) for any physical flaws, defects, wear, scratches, scuffs, tears, chips, or stains.
    Provide only a raw JSON containing: 
    {
      "title": "Optimized keywords title under 80 characters containing brand name, model, size/color, and condition",
      "detectedUPC": "numeric digits as a string, or null if no barcode is visible",
      "detectedDefects": ["list of wear, flaw, or defect strings, or empty array if none"]
    }
  `;
  if (barcode) {
    pass1Prompt = `
      Analyze these product photo(s) and UPC barcode: ${barcode}. 
      ${upcData ? `Verified eBay Catalog Details for this UPC:\nTitle: ${upcData.title}\nBrand: ${upcData.brand}\nMPN: ${upcData.mpn}\n` : ''}
      Also, scan the image(s) for any physical flaws, defects, wear, scratches, scuffs, tears, chips, or stains.
      Provide a raw JSON: 
      {
        "title": "Optimized keywords title under 80 characters containing brand, model, size/color, and condition",
        "detectedUPC": "${barcode}",
        "detectedDefects": ["list of wear, flaw, or defect strings, or empty array if none"]
      }
    `;
  }

  const pass1Schema = {
    type: "OBJECT",
    properties: {
      title: { 
        type: "STRING", 
        description: "Optimized keywords title under 80 characters containing brand name, model, size/color, and condition" 
      },
      detectedUPC: { 
        type: "STRING", 
        description: "numeric digits as a string, or null/empty if no barcode is visible" 
      },
      detectedDefects: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "list of wear, flaw, or defect strings, or empty array if none"
      }
    },
    required: ["title", "detectedUPC", "detectedDefects"]
  };

  const response1 = await ebayClient.fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: pass1Prompt },
          ...imageParts
        ]
      }],
      generationConfig: { 
        responseMimeType: "application/json",
        responseSchema: pass1Schema
      }
    })
  });

  const res1 = await response1.json();
  if (!response1.ok || !res1.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error(`Pass 1 generation failed: ${JSON.stringify(res1)}`);
  }
  
  const tempTitleObj = parseSafeJsonString(res1.candidates[0].content.parts[0].text);
  const draftTitle = tempTitleObj.title;
  const detectedBarcode = barcode || tempTitleObj.detectedUPC || null;

  let activeUpcData = upcData;
  if (detectedBarcode && !activeUpcData) {
    utils.logAudit("INFO", `Gemini vision auto-detected UPC barcode: ${detectedBarcode}. Querying eBay catalog...`);
    activeUpcData = await ebayClient.lookupUPCOnEbay(detectedBarcode);
  }

  let categoryId = "111422"; 
  let requiredAspects = [];
  let categorySuggestions = [];
  let aspectsMetadata = {};
  const token = ebayClient.getAccessToken();
  if (token) {
    categorySuggestions = await ebayClient.getCategorySuggestions(draftTitle);
    if (categorySuggestions.length > 0) {
      categoryId = categorySuggestions[0].id;
      requiredAspects = await ebayClient.getRequiredCategoryAspects(categoryId);
      aspectsMetadata = await ebayClient.getItemAspectsMetadata(categoryId);
    }
  }

  // 1. Fetch live market comps (Comps-Aware Copywriting)
  let comps = null;
  let compsPrompt = "";
  try {
    comps = await ebayClient.searchEbayComps(draftTitle, "USED_EXCELLENT");
    if (comps && comps.avgPrice) {
      compsPrompt = `\nLive eBay Market Comps Stats for similar items:\n- Min Price: $${comps.minPrice}\n- Max Price: $${comps.maxPrice}\n- Average Price: $${comps.avgPrice}\nUse this pricing context to suggest a competitive price. Mention in the description naturally why the item represents high value based on condition relative to these market benchmarks.`;
    }
  } catch (err) {
    utils.logAudit("WARN", `Failed to retrieve comps for AI generation: ${err.message}`);
  }

  // 2. Query history examples (Style Cloning)
  const styleCloningPrompt = getSimilarListingsFromHistory(draftTitle, 3);

  // 3. Define Copywriting Persona Prompt
  const persona = (options.persona || 'standard').toLowerCase();
  let personaPrompt = "";
  if (persona === 'luxury') {
    personaPrompt = "Use a sophisticated, elegant, and prestigious copywriting tone suited for a high-end luxury store. Focus heavily on authenticity details, product care, craftsmanship, and premium quality. Avoid overhyped marketing buzzwords.";
  } else if (persona === 'friendly') {
    personaPrompt = "Use a warm, friendly, conversational, and welcoming tone. Speak directly to the buyer as a passionate small-business seller. Feel free to use a few matching emojis (e.g., ✨, 📦) sparingly.";
  } else if (persona === 'vintage') {
    personaPrompt = "Use an informative, detailed, and collector-oriented historical tone. Emphasize age, specific patina, authenticity markings, model history, and collectible value.";
  } else if (persona === 'discount') {
    personaPrompt = "Use a direct, bold, value-focused, and concise tone. Put specifications, condition, and value savings first. Minimize flowery prose.";
  } else {
    personaPrompt = "Use a professional, SEO-optimized, clear, and descriptive tone designed to maximize eBay search relevance.";
  }

  // 4. Define HTML Template Style Prompt
  const template = (options.template || 'classic').toLowerCase();
  let templatePrompt = "";
  if (template === 'sleek_grid') {
    templatePrompt = "Format the description as a modern, premium HTML layout. Start with an engaging overview paragraph. Then, render a beautifully styled specifications table using CSS (e.g. `<table style='width: 100%; border-collapse: collapse; margin: 20px 0;'>` with light horizontal borders, padding, and subtle alternate-row shading). Add clean bullet points for shipping and seller guarantees at the bottom.";
  } else if (template === 'vintage_accordion') {
    templatePrompt = "Format the description with visually separated accordion-style sections. Use clean styled title headers (e.g., `<div style='background: #f7f5f0; border-left: 4px solid #c8921a; padding: 8px 12px; margin: 15px 0 8px; font-weight: bold;'>📜 Historical Context & Overview</div>`) to divide the overview, exact condition details, collector's markings, and specifications into clean thematic blocks.";
  } else if (template === 'minimalist') {
    templatePrompt = "Format the description with an ultra-clean, minimalist layout emphasizing editorial typography and ample whitespace. Use simple paragraphs (`<p>`), bold inline labels, and clear heading hierarchies (e.g. `<h2>`, `<h3>`) with no tables, borders, or backgrounds. Keep it extremely spacious and readable.";
  } else if (template === 'tech_dark') {
    templatePrompt = "Format the description as a sleek, high-tech terminal layout. Use clean code-like font styles, visual layout divider rows (e.g., `=========================================`), clear nested specification lists, and tech indicators (like `[SPEC]`, `[CONDITION]`, `[SHIPPING]`) wrapped in structured paragraphs for a modern, state-of-the-art gadget reseller look.";
  } else {
    templatePrompt = "Format the description with a clean, classic retail structure. Start with a solid introductory paragraph highlighting product benefits, followed by a well-organized bulleted list (`<ul>`, `<li>`) detailing specifications, condition comments, and delivery parameters.";
  }

  const pass2Prompt = `
    Analyze the product photo(s). Create a complete, highly SEO-optimized eBay listing JSON.
    You MUST output ONLY raw JSON conforming exactly to this schema:
    {
      "title": "SEO-optimized title under 80 characters. Utilize high-value keywords, brand, model, and item type. Do not use generic filler words.",
      "description": "Visual, highly detailed description structured with clean HTML tags (like <ul>, <li>, <p>, <strong>). Detail all specifications, condition comments, unique features, and ship-out details to maximize buyer trust and search ranking.",
      "brand": "Item Brand",
      "model": "Model number or MPN",
      "suggestedPrice": 29.99,
      "condition": "NEW | USED_EXCELLENT | USED_VERY_GOOD | USED_GOOD | FOR_PARTS_OR_NOT_WORKING",
      "weightMajor": 1,
      "weightMinor": 4,
      "packageLength": 12,
      "packageWidth": 9,
      "packageHeight": 5,
      "aspects": {
         // Include key-value details for this product.
      },
      "detectedDefects": [
         // Array of string descriptions of physical defects or wear found in the photos.
      ]
    }
    
    Copywriting Vibe Rules: ${personaPrompt}
    HTML Formatting Rules: ${templatePrompt}
    ${compsPrompt}
    ${styleCloningPrompt}
    ${customNotes ? `Important user notes/hints to include: "${customNotes}"` : ''}
    ${activeUpcData ? `Verified eBay Catalog Specifications: Brand=${activeUpcData.brand}, MPN=${activeUpcData.mpn}, Catalog Title=${activeUpcData.title}. Incorporate these specs.` : ''}
    ${Object.keys(aspectsMetadata).length > 0 ? `To help you populate the 'aspects' object correctly, here are the required/recommended aspect keys and their allowed standard values: \n${JSON.stringify(aspectsMetadata)}\nYou MUST choose values from these lists for the aspect keys.` : ''}
    ${tempTitleObj.detectedDefects && tempTitleObj.detectedDefects.length > 0 ? `Wear/Defects detected in pass 1: ${JSON.stringify(tempTitleObj.detectedDefects)}. Ensure these are listed in 'detectedDefects'.` : ''}
  `;

  const pass2Schema = {
    type: "OBJECT",
    properties: {
      title: { 
        type: "STRING", 
        description: "SEO-optimized title under 80 characters. Utilize high-value keywords, brand, model, and item type. Do not use generic filler words." 
      },
      description: { 
        type: "STRING", 
        description: "Visual, highly detailed description structured with clean HTML tags (like <ul>, <li>, <p>, <strong>). Detail all specifications, condition comments, unique features, and ship-out details." 
      },
      brand: { type: "STRING" },
      model: { type: "STRING" },
      suggestedPrice: { type: "NUMBER" },
      condition: { 
        type: "STRING", 
        enum: ["NEW", "USED_EXCELLENT", "USED_VERY_GOOD", "USED_GOOD", "FOR_PARTS_OR_NOT_WORKING"] 
      },
      weightMajor: { type: "INTEGER" },
      weightMinor: { type: "INTEGER" },
      packageLength: { type: "INTEGER" },
      packageWidth: { type: "INTEGER" },
      packageHeight: { type: "INTEGER" },
      aspects: {
        type: "OBJECT",
        description: "Key-value details for this product. All keys and values must be strings."
      },
      detectedDefects: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "Wear/flaws found in images."
      }
    },
    required: [
      "title", "description", "brand", "model", "suggestedPrice", "condition",
      "weightMajor", "weightMinor", "packageLength", "packageWidth", "packageHeight",
      "aspects", "detectedDefects"
    ]
  };

  const response2 = await ebayClient.fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: pass2Prompt },
          ...imageParts
        ]
      }],
      generationConfig: { 
        responseMimeType: "application/json",
        responseSchema: pass2Schema
      }
    })
  });

  const res2 = await response2.json();
  if (!response2.ok || !res2.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error(`Pass 2 generation failed: ${JSON.stringify(res2)}`);
  }

  const finalObj = parseSafeJsonString(res2.candidates[0].content.parts[0].text);
  finalObj.categoryId = categoryId;
  validateAndFixListingSchema(finalObj);

  // If comps was fetched, attach it to returned payload so backend gets latest stats
  if (comps) {
    finalObj.compsPriceInfo = comps;
  }

  return finalObj;
}

/**
 * Safely parses a JSON string, stripping markdown fences if present and falling back to default values or regex extraction.
 * @param {string} text - The raw text input.
 * @param {object} [defaultValue={}] - The default value to return if parsing fails.
 * @returns {object} The parsed JSON object.
 */
function parseSafeJsonString(text, defaultValue = {}) {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      const firstLineEnd = cleaned.indexOf("\n");
      const lastLineStart = cleaned.lastIndexOf("```");
      if (firstLineEnd !== -1 && lastLineStart !== -1 && lastLineStart > firstLineEnd) {
        cleaned = cleaned.substring(firstLineEnd, lastLineStart).trim();
      }
    }
    if (cleaned.startsWith("json")) {
      cleaned = cleaned.substring(4).trim();
    }
    // Remove trailing commas before trying to parse
    cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(cleaned);
  } catch (err) {
    utils.logAudit("ERROR", `Failed to parse JSON: ${err.message}. Raw: ${text}`);
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        let cleanAttempt = text.substring(start, end + 1);
        cleanAttempt = cleanAttempt.replace(/,\s*([\]}])/g, '$1');
        return JSON.parse(cleanAttempt);
      }
    } catch (e) {}
    return defaultValue;
  }
}

/**
 * Validates the listing schema, correcting types, lengths, and required aspects to conform to eBay parameters.
 * @param {object} data - The listing data to validate and sanitize in-place.
 * @returns {void}
 */
function validateAndFixListingSchema(data) {
  if (!data || typeof data !== 'object') {
    return;
  }
  if (!data.title || typeof data.title !== 'string') data.title = "Unnamed Listing item";
  if (data.title.length > 80) data.title = data.title.slice(0, 80);
  if (!data.description || typeof data.description !== 'string') data.description = "";
  
  if (typeof data.suggestedPrice !== 'number' || isNaN(data.suggestedPrice) || data.suggestedPrice <= 0) {
    const num = parseFloat(data.suggestedPrice);
    data.suggestedPrice = (!isNaN(num) && num > 0) ? num : 9.99;
  }
  data.suggestedPrice = Number(data.suggestedPrice.toFixed(2));
  
  if (!['NEW', 'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'FOR_PARTS_OR_NOT_WORKING'].includes(data.condition)) {
    data.condition = "USED_EXCELLENT";
  }
  
  if (!data.brand || typeof data.brand !== 'string' || data.brand.trim() === "") {
    data.brand = "Generic";
  } else {
    data.brand = data.brand.trim();
  }

  if (!data.model || typeof data.model !== 'string' || data.model.trim() === "") {
    data.model = "Does Not Apply";
  } else {
    data.model = data.model.trim();
  }
  
  if (!data.aspects || typeof data.aspects !== 'object') data.aspects = {};
  
  const cleanAspects = {};
  Object.keys(data.aspects).forEach(key => {
    const cleanKey = key.trim().slice(0, 40);
    let val = String(data.aspects[key]).trim();
    if (val.length > 50) {
      val = val.slice(0, 47) + "...";
    }
    if (cleanKey && val) {
      cleanAspects[cleanKey] = val;
    }
  });
  data.aspects = cleanAspects;
  
  data.weightMajor = Math.round(Number(data.weightMajor));
  if (isNaN(data.weightMajor) || data.weightMajor < 0) data.weightMajor = 1;

  data.weightMinor = Math.round(Number(data.weightMinor));
  if (isNaN(data.weightMinor) || data.weightMinor < 0 || data.weightMinor > 15) data.weightMinor = 0;

  data.packageLength = Math.round(Number(data.packageLength));
  if (isNaN(data.packageLength) || data.packageLength <= 0) data.packageLength = 10;

  data.packageWidth = Math.round(Number(data.packageWidth));
  if (isNaN(data.packageWidth) || data.packageWidth <= 0) data.packageWidth = 8;

  data.packageHeight = Math.round(Number(data.packageHeight));
  if (isNaN(data.packageHeight) || data.packageHeight <= 0) data.packageHeight = 6;

  if (!Array.isArray(data.detectedDefects)) {
    data.detectedDefects = [];
  }
  data.detectedDefects = data.detectedDefects.filter(d => typeof d === 'string' && d.trim().length > 0);
  if (data.detectedDefects.length > 0 && (!data.description || !data.description.includes("AI Condition Report (Defect Detection):"))) {
    const esc = (str) => typeof str === 'string' ? str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') : '';
    const defectBlock = `\n<div style="border: 1px solid #ef4444; padding: 10px; margin-top: 15px; background-color: #fef2f2; border-radius: 4px;">\n  <strong style="color: #991b1b;">AI Condition Report (Defect Detection):</strong>\n  <ul style="margin: 5px 0 0 20px; padding: 0; color: #7f1d1d;">\n    ${data.detectedDefects.map(d => `<li>${esc(d)}</li>`).join('\n    ')}\n  </ul>\n</div>`;
    if (!data.description) data.description = "";
    data.description += defectBlock;
  }
}

/**
 * Generates an optimized eBay listing draft from plain text keywords/title using Gemini.
 * @param {string} keywords - Product search term/title.
 * @returns {Promise<object>} Generated listing details matching the editor schema.
 */
async function generateListingFromKeywords(keywords) {
  const geminiKey = config.getGEMINI_API_KEY();
  if (!geminiKey) {
    throw new Error("GEMINI_API_KEY is not defined in your environment or .env file.");
  }

  utils.logAudit("INFO", `Generating listing details from keywords via Gemini: "${keywords}"`);

  const schema = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING", description: "Optimized title under 80 characters" },
      brand: { type: "STRING", description: "Brand name of the product" },
      model: { type: "STRING", description: "Model or part number of the product" },
      suggestedPrice: { type: "NUMBER", description: "Typical market retail/resale price in USD, e.g., 24.99" },
      condition: { type: "STRING", description: "One of: NEW, LIKE_NEW, USED_VERY_GOOD, USED_GOOD, USED_ACCEPTABLE" },
      weightMajor: { type: "INTEGER", description: "Estimated package weight in pounds (lbs), default 1" },
      weightMinor: { type: "INTEGER", description: "Estimated package weight in ounces (oz), default 0" },
      packageLength: { type: "INTEGER", description: "Estimated package length in inches, default 10" },
      packageWidth: { type: "INTEGER", description: "Estimated package width in inches, default 8" },
      packageHeight: { type: "INTEGER", description: "Estimated package height in inches, default 6" },
      description: { type: "STRING", description: "A detailed HTML or plain text eBay listing description including specifications and package contents" },
      categoryId: { type: "STRING", description: "Estimated eBay leaf category ID matching this item, default to '111422'" },
      aspects: { 
        type: "OBJECT", 
        description: "Key-value pairs of important product aspects like Brand, Model, Capacity, Color, Type, Size, UPC, MPN, etc.",
        properties: {
          Brand:       { type: "STRING" },
          Model:       { type: "STRING" },
          Type:        { type: "STRING" },
          Color:       { type: "STRING" },
          Size:        { type: "STRING" },
          Capacity:    { type: "STRING" },
          Material:    { type: "STRING" },
          UPC:         { type: "STRING" },
          MPN:         { type: "STRING" },
          "Country/Region of Manufacture": { type: "STRING" },
          "Active Ingredients": { type: "STRING" },
          Flavor:      { type: "STRING" },
          Scent:       { type: "STRING" },
          "Unit Count": { type: "STRING" },
          "Item Form":  { type: "STRING" }
        }
      }
    },
    required: ["title", "brand", "model", "suggestedPrice", "condition", "description", "categoryId", "aspects"]
  };

  const prompt = `
    Generate a complete, professional eBay listing draft for the product: "${keywords}".
    Based on the product name, estimate the correct specifications, typical size, color, brand, model, weight, dimensions, and the best matching eBay category ID.
    Provide only a raw JSON matching the schema.
  `;

  const response = await ebayClient.fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: { 
        responseMimeType: "application/json",
        responseSchema: schema
      }
    })
  });

  const resData = await response.json();
  if (!response.ok || !resData.candidates?.[0]?.content?.parts?.[0]?.text) {
    throw new Error(`Gemini keyword listing generation failed: ${JSON.stringify(resData)}`);
  }

  const generated = parseSafeJsonString(resData.candidates[0].content.parts[0].text, null);
  if (!generated) {
    throw new Error("Failed to parse valid JSON listing draft from Gemini response.");
  }
  
  // Set default values if missing
  if (!generated.condition) generated.condition = "USED_GOOD";
  if (typeof generated.suggestedPrice !== 'number') generated.suggestedPrice = 19.99;
  if (!generated.title) generated.title = keywords;
  if (!generated.description) generated.description = `eBay listing for ${keywords}`;
  if (!generated.aspects) generated.aspects = {};
  
  return generated;
}


module.exports = {
  runAIOrchestration,
  parseSafeJsonString,
  validateAndFixListingSchema,
  generateListingFromKeywords
};
