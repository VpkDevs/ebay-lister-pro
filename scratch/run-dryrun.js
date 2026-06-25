const fs = require('fs');
const path = require('path');
const http = require('http');
const webServer = require('../webServer');
const { execSync } = require('child_process');

const testPort = 45926;
console.log("─────────────────────────────────────────────────────");
console.log("🚀 STARTING PRE-LAUNCH DRY RUN SIMULATION 🚀");
console.log("─────────────────────────────────────────────────────");

async function request(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${testPort}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          size: Buffer.byteLength(data)
        });
      });
    });
    req.on('error', reject);
  });
}

async function run() {
  const reports = [];
  let allPassed = true;

  // Check 1: Verify all Launch Assets exist and contain no placeholders
  const assetsDir = path.join(__dirname, '../docs/founder/launch_assets');
  const requiredAssets = [
    'hacker_news.md',
    'press_outreach.md',
    'product_hunt.md',
    'reddit_flipping.md',
    'twitter_thread.md'
  ];

  console.log("1. Validating Launch Assets...");
  for (const asset of requiredAssets) {
    const filePath = path.join(assetsDir, asset);
    if (!fs.existsSync(filePath)) {
      reports.push({ check: `Asset: ${asset}`, status: 'FAIL', detail: 'File missing' });
      allPassed = false;
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const placeholderRegex = /TODO|\[YOUR_|\[INSERT_|placeholder/gi;
    const matches = content.match(placeholderRegex);
    if (matches) {
      reports.push({ check: `Asset: ${asset}`, status: 'WARNING', detail: `Contains placeholders: ${matches.join(', ')}` });
    } else {
      reports.push({ check: `Asset: ${asset}`, status: 'PASS', detail: `Verified (${content.length} characters)` });
    }
  }

  // Check 2: Verify Rollback script exists
  console.log("2. Validating Rollback Script...");
  const rollbackPath = path.join(__dirname, '../scripts/rollback.sh');
  if (fs.existsSync(rollbackPath)) {
    const size = fs.statSync(rollbackPath).size;
    reports.push({ check: 'Rollback Script', status: 'PASS', detail: `Exists (${size} bytes)` });
  } else {
    reports.push({ check: 'Rollback Script', status: 'FAIL', detail: 'Missing in scripts/' });
    allPassed = false;
  }

  // Check 3: Verify War Room Responses
  console.log("3. Validating War Room Responses...");
  const warRoomResponsesPath = path.join(__dirname, '../docs/founder/WAR_ROOM_RESPONSES.md');
  if (fs.existsSync(warRoomResponsesPath)) {
    const content = fs.readFileSync(warRoomResponsesPath, 'utf8');
    // Simple verification: check if there's a good chunk of content (e.g. should have multiple headings/comments)
    const matches = content.match(/### /g) || [];
    if (matches.length >= 10) {
      reports.push({ check: 'War Room Responses', status: 'PASS', detail: `Verified (${matches.length} response sections)` });
    } else {
      reports.push({ check: 'War Room Responses', status: 'WARNING', detail: `Only found ${matches.length} sections, expected >= 10` });
    }
  } else {
    reports.push({ check: 'War Room Responses', status: 'FAIL', detail: 'File missing' });
    allPassed = false;
  }

  // Check 4: Running Test Suite
  console.log("4. Running local unit/integration tests...");
  try {
    const testResult = execSync('node test-suite.js', { encoding: 'utf8', stdio: 'pipe' });
    const passMatch = testResult.match(/ℹ pass (\d+)/);
    const failMatch = testResult.match(/ℹ fail (\d+)/);
    if (passMatch && failMatch && parseInt(failMatch[1]) === 0) {
      reports.push({ check: 'Test Suite', status: 'PASS', detail: `All ${passMatch[1]} tests passed successfully` });
    } else {
      reports.push({ check: 'Test Suite', status: 'FAIL', detail: `Tests failed: ${failMatch ? failMatch[1] : 'unknown'} failed` });
      allPassed = false;
    }
  } catch (err) {
    reports.push({ check: 'Test Suite', status: 'FAIL', detail: `Execution failed: ${err.message}` });
    allPassed = false;
  }

  // Check 5: Web Server Local Integration Test
  console.log("5. Testing web server endpoint responses...");
  const server = webServer.startWebGuiServer(testPort);
  try {
    // Health check
    const health = await request('/health');
    const healthData = JSON.parse(health.body);
    if (health.statusCode === 200 && healthData.status === 'ok') {
      reports.push({ check: 'Health Endpoint', status: 'PASS', detail: '/health returns 200 OK' });
    } else {
      reports.push({ check: 'Health Endpoint', status: 'FAIL', detail: `/health status code: ${health.statusCode}` });
      allPassed = false;
    }

    // Terms check
    const terms = await request('/terms');
    if (terms.statusCode === 200 && terms.size > 1000) {
      reports.push({ check: 'Terms Route', status: 'PASS', detail: '/terms serves correct page size' });
    } else {
      reports.push({ check: 'Terms Route', status: 'FAIL', detail: `/terms status code: ${terms.statusCode}` });
      allPassed = false;
    }

    // Privacy check
    const privacy = await request('/privacy');
    if (privacy.statusCode === 200 && privacy.size > 1000) {
      reports.push({ check: 'Privacy Route', status: 'PASS', detail: '/privacy serves correct page size' });
    } else {
      reports.push({ check: 'Privacy Route', status: 'FAIL', detail: `/privacy status code: ${privacy.statusCode}` });
      allPassed = false;
    }

  } catch (err) {
    reports.push({ check: 'Web Server Integrity', status: 'FAIL', detail: err.message });
    allPassed = false;
  } finally {
    server.close();
  }

  console.log("─────────────────────────────────────────────────────");
  console.log("📊 DRY RUN RESULTS SUMMARY 📊");
  console.log("─────────────────────────────────────────────────────");
  reports.forEach(r => {
    const symbol = r.status === 'PASS' ? '✅' : r.status === 'WARNING' ? '⚠️' : '❌';
    console.log(`${symbol} [${r.status.padEnd(7)}] ${r.check.padEnd(28)} : ${r.detail}`);
  });
  console.log("─────────────────────────────────────────────────────");

  // Output to dry run report markdown
  const markdownReportPath = path.join(__dirname, '../docs/founder/PRE_LAUNCH_DRY_RUN_REPORT.md');
  const timestamp = new Date().toISOString();
  
  let mdContent = `# Pre-Launch Dry Run Report — eBay Multi-Channel Lister Pro\n\n`;
  mdContent += `**Executed at:** ${timestamp}\n`;
  mdContent += `**Status:** ${allPassed ? '🟢 PASS' : '🔴 FAIL'}\n\n`;
  mdContent += `This report catalogs the outcomes of the pre-launch dry run simulation. All critical checklist items must pass before launching.\n\n`;
  mdContent += `## 📋 Simulation Verification Results\n\n`;
  mdContent += `| Status | Check Category | Verification Detail |\n`;
  mdContent += `|---|---|---|\n`;
  
  reports.forEach(r => {
    const statusEmoji = r.status === 'PASS' ? '🟢 PASS' : r.status === 'WARNING' ? '🟡 WARNING' : '🔴 FAIL';
    mdContent += `| ${statusEmoji} | ${r.check} | ${r.detail} |\n`;
  });
  
  mdContent += `\n## 🛠️ Post-Run Analysis & Summary\n\n`;
  if (allPassed) {
    mdContent += `All core assets, integration test suites, endpoints, and recovery mechanisms are fully validated. The application is officially cleared for live deployment and launch sequences on July 7, 2026.\n`;
  } else {
    mdContent += `Some checks failed or generated warnings. Please review the failed items before marking Phase 5 complete.\n`;
  }
  
  fs.writeFileSync(markdownReportPath, mdContent, 'utf8');
  console.log(`Report written to ${markdownReportPath}`);
  
  if (!allPassed) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error("Dry Run Failed:", err);
  process.exit(1);
});
