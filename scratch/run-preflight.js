const http = require('http');
const path = require('path');
const fs = require('fs');
const webServer = require('../webServer');

const testPort = 45925;
console.log("─────────────────────────────────────────────────────");
console.log("ATLAS PRE-FLIGHT LOCAL RUNNER");
console.log(`Starting test server on port ${testPort}...`);

const server = webServer.startWebGuiServer(testPort);

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
  const checklist = [];
  let allPassed = true;

  try {
    // Check 1: Responsive
    try {
      const res = await request('/');
      const passed = res.statusCode === 200 && res.size > 1024;
      checklist.push({ id: 1, name: "Production responsive (local)", status: passed ? "✅ GREEN" : "❌ RED", detail: `Status: ${res.statusCode}, Size: ${res.size}B` });
      if (!passed) allPassed = false;
    } catch (e) {
      checklist.push({ id: 1, name: "Production responsive (local)", status: "❌ RED", detail: e.message });
      allPassed = false;
    }

    // Check 2: Healthcheck
    try {
      const res = await request('/health');
      const data = JSON.parse(res.body);
      const passed = res.statusCode === 200 && data.status === "ok";
      checklist.push({ id: 2, name: "Healthcheck live", status: passed ? "✅ GREEN" : "❌ RED", detail: `Status: ${res.statusCode}, Payload: ${res.body}` });
      if (!passed) allPassed = false;
    } catch (e) {
      checklist.push({ id: 2, name: "Healthcheck live", status: "❌ RED", detail: e.message });
      allPassed = false;
    }

    // Check 5: Legal pages
    for (const p of ['/terms', '/privacy']) {
      try {
        const res = await request(p);
        const passed = res.statusCode === 200 && res.size > 500;
        checklist.push({ id: 5, name: `Legal page: ${p}`, status: passed ? "✅ GREEN" : "❌ RED", detail: `Status: ${res.statusCode}, Size: ${res.size}B` });
        if (!passed) allPassed = false;
      } catch (e) {
        checklist.push({ id: 5, name: `Legal page: ${p}`, status: "❌ RED", detail: e.message });
        allPassed = false;
      }
    }

    // Check 9: Security headers
    try {
      const res = await request('/');
      const hasCSP = !!res.headers['content-security-policy'];
      const hasFrame = !!res.headers['x-frame-options'];
      const hasNosniff = !!res.headers['x-content-type-options'];
      const passed = hasCSP && hasFrame && hasNosniff;
      checklist.push({ 
        id: 9, 
        name: "Security headers", 
        status: passed ? "✅ GREEN" : "⚠️ YELLOW", 
        detail: `CSP: ${hasCSP ? "Yes" : "No"}, FrameOptions: ${hasFrame ? "Yes" : "No"}, Nosniff: ${hasNosniff ? "Yes" : "No"}` 
      });
    } catch (e) {
      checklist.push({ id: 9, name: "Security headers", status: "❌ RED", detail: e.message });
      allPassed = false;
    }

  } finally {
    console.log("Shutting down test server...");
    await new Promise(resolve => server.close(resolve));
  }

  console.log("─────────────────────────────────────────────────────");
  console.log("PRE-FLIGHT LOCAL CHECKLIST RESULT:");
  checklist.forEach(c => {
    console.log(`[Check ${c.id}] ${c.name.padEnd(35)} [${c.status}] - ${c.detail}`);
  });
  console.log("─────────────────────────────────────────────────────");
  if (allPassed) {
    console.log("RESULT: PASS (Local endpoints fully validated)");
  } else {
    console.log("RESULT: FAIL");
  }
  console.log("─────────────────────────────────────────────────────");
}

run().catch(err => {
  console.error("Runner failed:", err);
  process.exit(1);
});
