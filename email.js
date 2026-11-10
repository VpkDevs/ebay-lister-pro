/**
 * email.js — transactional email plumbing (Atlas Phase 8).
 *
 * Provider: Resend (RESEND_API_KEY + EMAIL_FROM env vars). Until both are
 * set, every send is an explicit no-op that logs EMAIL_NOT_CONFIGURED and
 * returns { sent: false } — the call sites are wired and tested now, and
 * email activates the moment the operator adds the key. Nothing in this
 * module ever throws into a request handler.
 */
'use strict';

function isEmailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

async function sendEmail({ to, subject, text }) {
  if (!isEmailConfigured()) {
    console.log(`[email] EMAIL_NOT_CONFIGURED — skipped "${subject}" to ${to}`);
    return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text })
    });
    if (!res.ok) return { sent: false, reason: `PROVIDER_${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: `PROVIDER_ERROR: ${err.message}` };
  }
}

const WELCOME = {
  subject: 'Your first listing is the whole product',
  text: [
    'Welcome to ListAI Pro.',
    '',
    'Skip the tour: upload one photo of anything on your death pile and watch it come back as a priced listing draft. That 60 seconds is the entire pitch.',
    '',
    'If the price looks wrong, check the comps it shows you — that panel is the part to play with first.',
    '',
    '— Vince (founder; replies to this email reach me)'
  ].join('\n')
};

function sendWelcomeEmail(to) {
  return sendEmail({ to, subject: WELCOME.subject, text: WELCOME.text });
}

module.exports = { isEmailConfigured, sendEmail, sendWelcomeEmail, WELCOME };
