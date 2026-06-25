/**
 * @file geminiClient.js
 * @description Interfaces with the Google Gemini API to analyze product photos and generate optimized eBay listings.
 */

const config = require('./config');
const utils = require('./utils');
const ebayClient = require('./ebayClient');

/**
 * Runs the Gemini AI orchestration to generate listing details based on product photos and metadata.
 * @param {Buffer[]} photoBuffers - Array of image file buffers.
 * @param {string[]} filenames - Array of image filenames matching the buffers.
 * @param {string|null} [barcode] - Optional barcode or UPC number.
 * @param {string|null} [customNotes] - Optional custom notes/instructions from user.
 * @param {object|null} [upcData] - Optional verified catalog details from eBay catalog.
 * @returns {Promise<object>} The validated and formatted listing object.
 * @throws {Error} If parameters are invalid or Gemini API call fails.
 */
async function runAIOrchestration(photoBuffers, filenames, barcode = null, customNotes = null, upcData = null) {
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
  const token = ebayClient.getAccessToken();
  if (token) {
    categorySuggestions = await ebayClient.getCategorySuggestions(draftTitle);
    if (categorySuggestions.length > 0) {
      categoryId = categorySuggestions[0].id;
      requiredAspects = await ebayClient.getRequiredCategoryAspects(categoryId);
    }
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
    
    ${customNotes ? `Important user notes/hints to include: "${customNotes}"` : ''}
    ${activeUpcData ? `Verified eBay Catalog Specifications: Brand=${activeUpcData.brand}, MPN=${activeUpcData.mpn}, Catalog Title=${activeUpcData.title}. Incorporate these specs.` : ''}
    ${requiredAspects.length > 0 ? `For the 'aspects' object, you MUST include values for the following required taxonomy keys: ${JSON.stringify(requiredAspects)}` : ''}
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

module.exports = {
  runAIOrchestration,
  parseSafeJsonString,
  validateAndFixListingSchema
};
