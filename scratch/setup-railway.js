const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log("======================================================");
  console.log("🚀 AUTOMATED RAILWAY TOKEN SETUP");
  console.log("======================================================");
  console.log("Opening browser window on your screen...");
  console.log("👉 ACTION REQUIRED: Please log in to your Railway Account.");
  console.log("======================================================");

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();

  // Go to Railway login
  await page.goto('https://railway.app/login');

  let token = null;
  let attempt = 0;

  while (attempt < 120) { // 4 minutes timeout
    const url = page.url();
    
    // Check if user has logged in and is on settings page
    if (url.includes('railway.app/settings')) {
      try {
        console.log("On Railway settings. Navigating to account tokens...");
        
        // Find and click tokens/keys tab or element
        const tokenTab = page.locator('text=Tokens, a[href*="tokens"]').first();
        if (await tokenTab.isVisible()) {
          await tokenTab.click();
        }
        
        // Wait for generate token form
        const nameInput = page.locator('input[placeholder*="Token Name"], input[name*="name"]').first();
        if (await nameInput.isVisible()) {
          console.log("Creating Lister Pro CLI token...");
          await nameInput.fill("Lister Pro CLI");
          await page.keyboard.press('Enter');
          
          // Wait for token string to display (starts with cli_)
          console.log("Waiting for Railway to generate token...");
          let tokenFound = false;
          for (let i = 0; i < 20; i++) {
            const bodyText = await page.innerText('body');
            const match = bodyText.match(/cli_[A-Za-z0-9_-]+/);
            if (match) {
              token = match[0];
              tokenFound = true;
              break;
            }
            await new Promise(r => setTimeout(r, 1000));
          }
          if (token) break;
        }
      } catch (err) {
        // Page loading or transitioning
      }
    } else if (url.includes('railway.app/dashboard') || url.includes('railway.app/proj')) {
      // If logged in but on dashboard, redirect directly to settings
      console.log("Logged in. Navigating directly to Settings...");
      await page.goto('https://railway.app/settings');
    }
    
    await new Promise(r => setTimeout(r, 2000));
    attempt++;
  }

  if (token) {
    console.log("\n======================================================");
    console.log("🎉 SUCCESS: Railway Token Extracted successfully!");
    console.log(`Token: ${token.slice(0, 8)}...`);
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

    if (envContent.includes('RAILWAY_TOKEN=')) {
      envContent = envContent.replace(/RAILWAY_TOKEN=.*/, `RAILWAY_TOKEN=${token}`);
    } else {
      envContent += `\nRAILWAY_TOKEN=${token}`;
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log("Saved RAILWAY_TOKEN to your local .env file!");
  } else {
    console.log("❌ Timeout or token extraction failed. Please retrieve the token manually.");
  }

  console.log("Closing browser in 5 seconds...");
  await new Promise(r => setTimeout(r, 5000));
  await browser.close();
})();
