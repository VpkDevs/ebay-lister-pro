const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const utils = require('../utils');
const db = require('../lib/db');
const ebayClient = require('../ebayClient');
const activeSessions = require('../lib/sessions');

const router = express.Router();

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

// API: eBay OAuth Redirect Login
router.get('/api/auth/ebay/login', (req, res) => {
  const clientId = config.getEBAY_CLIENT_ID();
  const ruName = config.getEBAY_RUNAME() || "your_ebay_ru_name";
  if (!clientId || clientId === 'your_ebay_client_id') {
    return res.status(400).json({ error: "Missing eBay Client ID" });
  }

  const scopes = encodeURIComponent("https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account");
  const ebayAuthUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${ruName}&response_type=code&scope=${scopes}`;
  res.redirect(ebayAuthUrl);
});

// API: eBay OAuth Callback
router.get('/api/auth/ebay/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/?error=ebay_code_missing');
  }

  try {
    const clientId = config.getEBAY_CLIENT_ID();
    const clientSecret = config.getEBAY_CLIENT_SECRET();
    const ruName = config.getEBAY_RUNAME() || "your_ebay_ru_name";

    const tokenUrl = "https://api.ebay.com/identity/v1/oauth2/token";
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const payload = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName
    }).toString();

    const tokenRes = await ebayClient.fetchWithRetry(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${credentials}`
      },
      body: payload
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`eBay token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const newRefreshToken = tokenData.refresh_token;
    const newAccessToken = tokenData.access_token;

    ebayClient.setAccessToken(newAccessToken);
    process.env.EBAY_REFRESH_TOKEN = newRefreshToken;

    let envContent = '';
    if (fs.existsSync(config.envPath)) {
      envContent = fs.readFileSync(config.envPath, 'utf8');
    }
    let lines = envContent.split(/\r?\n/);
    const index = lines.findIndex(l => l.trim().startsWith('EBAY_REFRESH_TOKEN=') || l.trim().startsWith('#EBAY_REFRESH_TOKEN='));
    if (index !== -1) {
      lines[index] = `EBAY_REFRESH_TOKEN=${newRefreshToken}`;
    } else {
      lines.push(`EBAY_REFRESH_TOKEN=${newRefreshToken}`);
    }
    fs.writeFileSync(config.envPath, lines.join('\n'), 'utf8');
    utils.logAudit("INFO", "eBay OAuth connection successful. Refresh token updated.");

    res.redirect('/?ebay_auth=success');
  } catch (err) {
    res.status(500).send(`eBay Authentication Error: ${err.message}`);
  }
});

// API: Google OAuth Redirect Login
router.get('/api/auth/google/login', (req, res) => {
  const clientId = config.getGOOGLE_CLIENT_ID();
  const redirectUri = encodeURIComponent(config.getGOOGLE_REDIRECT_URI());
  if (!clientId) {
    // Auto-login mock for local dev
    const sessionId = crypto.randomBytes(32).toString('hex');
    const userObj = { email: "local-admin@lister.pro", isPremium: true };
    activeSessions.set(sessionId, { user: userObj, expiresAt: Date.now() + 86400000 });

    res.cookie('sessionId', sessionId, { path: '/', httpOnly: true, sameSite: 'Lax', secure: true });
    return res.redirect('/');
  }

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=openid%20email%20profile`;
  res.redirect(googleAuthUrl);
});

// API: Google OAuth Callback
router.get('/api/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/?error=code_missing');
  }

  try {
    const tokenUrl = "https://oauth2.googleapis.com/token";
    const payload = new URLSearchParams({
      code,
      client_id: config.getGOOGLE_CLIENT_ID(),
      client_secret: config.getGOOGLE_CLIENT_SECRET(),
      redirect_uri: config.getGOOGLE_REDIRECT_URI(),
      grant_type: "authorization_code"
    }).toString();

    const tokenRes = await ebayClient.fetchWithRetry(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: payload
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`Google token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const accessToken = tokenData.access_token;
    const userInfoRes = await ebayClient.fetchWithRetry("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });

    const userInfo = await userInfoRes.json();
    if (!userInfoRes.ok) {
      throw new Error(`Google userinfo failed: ${JSON.stringify(userInfo)}`);
    }

    const email = userInfo.email;
    const billingHistory = db.billing.get();
    const isPremium = !!(billingHistory[email] && billingHistory[email].premium);

    const sessionId = crypto.randomBytes(32).toString('hex');
    const userObj = { email, name: userInfo.name, picture: userInfo.picture, isPremium };
    activeSessions.set(sessionId, { user: userObj, expiresAt: Date.now() + 86400000 });

    res.cookie('sessionId', sessionId, { path: '/', httpOnly: true, sameSite: 'Lax', secure: true });
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Authentication Error: ${err.message}`);
  }
});

// API: Logout
router.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.sessionId;
  if (sessionId) {
    activeSessions.delete(sessionId);
  }
  res.clearCookie('sessionId', { path: '/' });
  res.json({ success: true });
});

// API: Delete Account
router.delete('/api/user/account', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.sessionId;
  let email = null;
  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    email = session.user?.email;
    activeSessions.delete(sessionId);
  }

  if (email) {
    const billingHistory = db.billing.get();
    if (billingHistory[email]) {
      delete billingHistory[email];
      utils.persistBilling(billingHistory);
    }
    utils.logAudit("INFO", `Account data deleted for user: ${email}`);
  }

  res.clearCookie('sessionId', { path: '/' });
  res.json({ success: true, message: "User session and billing record deleted." });
});

// API: Session info
router.get('/api/auth/session', (req, res) => {
  res.json({
    authenticated: !!req.user,
    user: req.user || null,
    googleLoginEnabled: !!config.getGOOGLE_CLIENT_ID()
  });
});

module.exports = router;
