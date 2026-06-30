const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log("======================================================");
  console.log("🚀 AUTOMATED GEMINI API KEY SETUP");
  console.log("======================================================");
  console.log("Opening browser window on your screen...");
  console.log("👉 ACTION REQUIRED: Please sign in to your Google Account if prompted.");
  console.log("======================================================");

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();

  // Go to Google AI Studio API key page
  await page.goto('https://aistudio.google.com/app/apikey');

  let key = null;
  let attempt = 0;

  while (attempt < 120) { // 4 minutes timeout
    const url = page.url();
    
    // Check if we are on the API key creation dashboard
    if (url.includes('aistudio.google.com/app/')) {
      try {
        // Look for the mat-button containing "Create API key"
        const createBtn = page.locator('button:has-text("Create API key"), button:has-text("Create API Key")').first();
        if (await createBtn.isVisible()) {
          console.log("API Key page loaded. Triggering key creation...");
          await createBtn.click();
          
          // Wait for the popup selector "Create API key in new project"
          const newProjBtn = page.locator('button:has-text("Create API key in new project")').first();
          await newProjBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
          
          if (await newProjBtn.isVisible()) {
            console.log("Creating key in a new Google Cloud project...");
            await newProjBtn.click();
          }

          // Polling for the generated key (usually in a text input starting with AIzaSy)
          console.log("Waiting for Google AI Studio to output the key string...");
          let keyFound = false;
          for (let i = 0; i < 30; i++) {
            // Option 1: check readonly inputs
            const readonlyInputs = await page.locator('input[readonly]').all();
            for (const input of readonlyInputs) {
              const val = await input.inputValue();
              if (val && val.startsWith('AIzaSy')) {
                key = val;
                keyFound = true;
                break;
              }
            }
            if (keyFound) break;

            // Option 2: search body innerText
            const bodyText = await page.innerText('body');
            const match = bodyText.match(/AIzaSy[A-Za-z0-9_-]{33}/);
            if (match) {
              key = match[0];
              keyFound = true;
              break;
            }
            await new Promise(r => setTimeout(r, 1000));
          }

          if (key) {
            break;
          }
        }
      } catch (err) {
        // Page elements not loaded yet
      }
    }
    await new Promise(r => setTimeout(r, 2000));
    attempt++;
  }

  if (key) {
    console.log("\n======================================================");
    console.log("🎉 SUCCESS: Gemini API Key Extracted successfully!");
    console.log(`Key: ${key.slice(0, 8)}...${key.slice(-4)}`);
    console.log("======================================================");

    // Save to local .env file
    const projectRoot = path.join(__dirname, '..');
    const envPath = path.join(projectRoot, '.env');
    let envContent = '';

    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    } else {
      const examplePath = path.join(projectRoot, '.env.example');
      if (fs.existsSync(examplePath)) {
        envContent = fs.readFileSync(examplePath, 'utf8');
      }
    }

    if (envContent.includes('GEMINI_API_KEY=')) {
      envContent = envContent.replace(/GEMINI_API_KEY=.*/, `GEMINI_API_KEY=${key}`);
    } else {
      envContent += `\nGEMINI_API_KEY=${key}`;
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log("Saved GEMINI_API_KEY to your local .env file!");
  } else {
    console.log("❌ Timeout or key extraction failed. Please retrieve the key manually.");
  }

  console.log("Closing browser in 5 seconds...");
  await new Promise(r => setTimeout(r, 5000));
  await browser.close();
})();
