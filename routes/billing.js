/**
 * @file routes/billing.js
 * @description Express router for Stripe subscription billing, mock checkout flows, and Stripe webhook integration.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const utils = require('../utils');
const db = require('../lib/db');
const ebayClient = require('../ebayClient');
const activeSessions = require('../lib/sessions');

const router = express.Router();

// Helper to update active sessions for premium status
function updateSessionPremiumStatus(email, isPremium) {
  for (const session of activeSessions.values()) {
    if (session.user && session.user.email === email) {
      session.user.isPremium = isPremium;
    }
  }
}

// API: Stripe Checkout Session creation
router.post('/api/billing/create-checkout-session', async (req, res, next) => {
  const stripeSecret = config.getSTRIPE_SECRET_KEY();
  const port = config.getPORT();

  if (!stripeSecret) {
    // Dev mock fallback if Stripe not configured
    return res.json({ url: '/api/billing/mock-success' });
  }

  try {
    const userEmail = req.user ? req.user.email : "customer@local.lister";
    const stripePayload = new URLSearchParams({
      "success_url": `http://localhost:${port}/?billing=success`,
      "cancel_url": `http://localhost:${port}/?billing=cancel`,
      "mode": "subscription",
      "customer_email": userEmail,
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": "Lister Pro Premium Subscription",
      "line_items[0][price_data][unit_amount]": "2900", // $29.00
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][quantity]": "1"
    }).toString();

    const stripeRes = await ebayClient.fetchWithRetry("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${Buffer.from(stripeSecret + ':').toString('base64')}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: stripePayload
    });

    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) {
      throw new Error(`Stripe API error: ${JSON.stringify(stripeData)}`);
    }

    res.json({ url: stripeData.url });
  } catch (err) {
    next(err);
  }
});

// API: Stripe Mock Success
router.get('/api/billing/mock-success', (req, res) => {
  if (req.user) {
    req.user.isPremium = true;
    const billingHistory = db.billing.get();
    billingHistory[req.user.email] = { premium: true, subscriptionId: "mock-sub-12345" };
    db.billing.save(billingHistory);
    updateSessionPremiumStatus(req.user.email, true);
  }
  res.redirect('/?billing=success');
});

// API: Stripe Webhook
router.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const signatureHeader = req.headers['stripe-signature'];
    const webhookSecret = config.getSTRIPE_WEBHOOK_SECRET();
    // Raw body buffer is needed to verify webhook signatures in Stripe
    const rawBody = req.body.toString('utf8');

    if (webhookSecret && signatureHeader) {
      const sigParts = signatureHeader.split(',');
      const timestampPart = sigParts.find(p => p.startsWith('t='));
      const signaturePart = sigParts.find(p => p.startsWith('v1='));

      if (!timestampPart || !signaturePart) {
        return res.status(400).json({ error: "Invalid signature headers" });
      }

      const timestamp = timestampPart.split('=')[1];
      const signature = signaturePart.split('=')[1];
      const signedPayload = `${timestamp}.${rawBody}`;

      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(signedPayload)
        .digest('hex');

      if (signature !== expectedSignature) {
        return res.status(400).json({ error: "Invalid Stripe signature" });
      }
    }

    const event = JSON.parse(rawBody);
    const billingHistory = db.billing.get();

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      if (email) {
        billingHistory[email] = { premium: true, subscriptionId: session.subscription };
        db.billing.save(billingHistory);
        utils.logAudit("INFO", `Stripe Premium Activated for customer: ${email}`);
        updateSessionPremiumStatus(email, true);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      let changed = false;
      for (const email of Object.keys(billingHistory)) {
        if (billingHistory[email].subscriptionId === subscription.id) {
          billingHistory[email].premium = false;
          utils.logAudit("INFO", `Stripe Premium Expired for customer: ${email}`);
          updateSessionPremiumStatus(email, false);
          changed = true;
        }
      }
      if (changed) {
        db.billing.save(billingHistory);
      }
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
