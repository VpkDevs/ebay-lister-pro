const pino = require('pino');
const pretty = require('pino-pretty');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Secret Redaction helper
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeLog(message) {
  if (typeof message !== 'string') return message;
  let clean = message;

  const secrets = [
    { value: config.getGEMINI_API_KEY(), label: '[REDACTED_GEMINI_KEY]' },
    { value: config.getEBAY_CLIENT_SECRET(), label: '[REDACTED_CLIENT_SECRET]' },
    { value: config.getEBAY_REFRESH_TOKEN(), label: '[REDACTED_REFRESH_TOKEN]' },
    { value: config.getSTRIPE_SECRET_KEY(), label: '[REDACTED_STRIPE_SECRET_KEY]' },
    { value: config.getSTRIPE_WEBHOOK_SECRET(), label: '[REDACTED_STRIPE_WEBHOOK_SECRET]' },
    { value: config.getWOOCOMMERCE_KEY(), label: '[REDACTED_WOOCOMMERCE_KEY]' },
    { value: config.getWOOCOMMERCE_SECRET(), label: '[REDACTED_WOOCOMMERCE_SECRET]' },
    { value: config.getETSY_ACCESS_TOKEN(), label: '[REDACTED_ETSY_ACCESS_TOKEN]' }
  ];

  for (const secret of secrets) {
    if (secret.value && typeof secret.value === 'string' && secret.value.trim().length > 0) {
      const escaped = escapeRegExp(secret.value.trim());
      clean = clean.replace(new RegExp(escaped, 'g'), secret.label);
    }
  }

  // Scrub Shopify tokens via pattern matching
  clean = clean.replace(/shpat_[a-zA-Z0-9]{32}/g, '[REDACTED_SHOPIFY_TOKEN]');
  // Scrub WooCommerce consumer credentials via pattern matching
  clean = clean.replace(/ck_[a-zA-Z0-9]{40}/g, '[REDACTED_WOOCOMMERCE_KEY]');
  clean = clean.replace(/cs_[a-zA-Z0-9]{40}/g, '[REDACTED_WOOCOMMERCE_SECRET]');
  // Scrub Basic Auth headers
  clean = clean.replace(/Basic\s+[a-zA-Z0-9+/=]+/gi, 'Basic [REDACTED_AUTH_HEADER]');
  // Scrub Bearer tokens
  clean = clean.replace(/Bearer\s+[a-zA-Z0-9\-._~+/=]+/gi, 'Bearer [REDACTED_BEARER_TOKEN]');

  return clean;
}

function deepSanitize(obj) {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return sanitizeLog(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(deepSanitize);
  }
  if (typeof obj === 'object') {
    const cleanObj = {};
    for (const key of Object.keys(obj)) {
      cleanObj[key] = deepSanitize(obj[key]);
    }
    return cleanObj;
  }
  return obj;
}

const isDev = process.env.NODE_ENV !== 'production';

// In development, stdout is pretty printed. In production, it's JSON stdout.
const stdoutStream = isDev ? pretty({ colorize: true, messageKey: 'message', translateTime: 'yyyy-mm-dd HH:MM:ss.l o' }) : process.stdout;

// Audit log file always gets JSON lines
const fileStream = {
  write(str) {
    try {
      fs.appendFileSync(config.logPath, str, 'utf8');
    } catch (e) {
      // silently ignore write errors to prevent crashing
    }
  }
};

const streams = [
  { stream: stdoutStream },
  { stream: fileStream }
];

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  messageKey: 'message',
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level: (label, number) => {
      return { level: label.toUpperCase() };
    }
  },
  hooks: {
    logMethod(inputArgs, method) {
      const sanitizedArgs = inputArgs.map(arg => deepSanitize(arg));
      return method.apply(this, sanitizedArgs);
    }
  }
}, pino.multistream(streams));

module.exports = logger;
