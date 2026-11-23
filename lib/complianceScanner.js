/**
 * @file lib/complianceScanner.js
 * @description Non-destructive eBay Active Content Policy compliance scanner.
 *   Scans listing HTML descriptions for policy violations (external JS, HTTP image
 *   sources, iframes, Flash, etc.) and reports them with line-level context.
 *   Offers opt-in auto-fix that cleans violations automatically.
 */

'use strict';

const POLICY_RULES = [
  {
    type: 'SCRIPT_TAG',
    pattern: /<script[\s>]/gi,
    rule: 'eBay prohibits <script> tags in listing descriptions (Active Content Policy).',
    autoFixable: true,
  },
  {
    type: 'JAVASCRIPT_HREF',
    pattern: /href\s*=\s*["']javascript:/gi,
    rule: 'JavaScript href handlers are banned (Active Content Policy).',
    autoFixable: true,
  },
  {
    type: 'ON_EVENT_HANDLER',
    pattern: /\bon\w+\s*=\s*["'][^"']*["']/gi,
    rule: 'Inline event handlers (onclick, onmouseover, etc.) are prohibited.',
    autoFixable: true,
  },
  {
    type: 'HTTP_IMAGE',
    pattern: /<img[^>]+src\s*=\s*["']http:\/\//gi,
    rule: 'Images must use HTTPS. HTTP image sources violate eBay\'s security policy.',
    autoFixable: true,
  },
  {
    type: 'HTTP_IFRAME',
    pattern: /<iframe[^>]+src\s*=\s*["']http:\/\//gi,
    rule: 'iframes must use HTTPS sources.',
    autoFixable: true,
  },
  {
    type: 'FLASH_OBJECT',
    pattern: /<object[^>]*>/gi,
    rule: 'Flash <object> embeds are prohibited (Flash is end-of-life and banned by eBay).',
    autoFixable: false,
  },
  {
    type: 'FLASH_EMBED',
    pattern: /<embed[^>]*>/gi,
    rule: 'Flash <embed> tags are prohibited by eBay Active Content Policy.',
    autoFixable: false,
  },
  {
    type: 'EXTERNAL_LINK',
    pattern: /href\s*=\s*["'](https?:\/\/(?!rover\.ebay\.com|www\.ebay\.com)[^"']+)["']/gi,
    rule: 'External links in listing descriptions may violate eBay off-site linking policies.',
    autoFixable: false,
  },
  {
    type: 'FORM_TAG',
    pattern: /<form[\s>]/gi,
    rule: '<form> elements are banned in eBay listing descriptions.',
    autoFixable: true,
  },
  {
    type: 'INPUT_TAG',
    pattern: /<input[\s>]/gi,
    rule: '<input> elements are banned in eBay listing descriptions.',
    autoFixable: true,
  },
  {
    type: 'META_REFRESH',
    pattern: /<meta[^>]+http-equiv\s*=\s*["']refresh["']/gi,
    rule: 'Meta refresh redirects are prohibited.',
    autoFixable: true,
  },
  {
    type: 'OFFSITE_CONTACT',
    pattern: /\b(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{3}[-.\s]\d{3}[-.\s]\d{4})\b/gi,
    rule: 'Direct email addresses and phone numbers violate eBay off-site contact policy.',
    autoFixable: true,
  },
];

function buildExcerpt(line, match) {
  const start = Math.max(0, match.index - 20);
  const end = Math.min(line.length, match.index + match[0].length + 40);
  let excerpt = line.slice(start, end).trim();
  if (excerpt.length > 120) excerpt = excerpt.slice(0, 117) + '...';
  return excerpt;
}

function scanHtml(html) {
  if (typeof html !== 'string') {
    return { compliant: true, violationCount: 0, violations: [] };
  }

  const lines = html.split('\n');
  const violations = [];
  const seen = new Set();

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNumber = lineIdx + 1;
    const lineText = lines[lineIdx];

    for (const rule of POLICY_RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(lineText)) !== null) {
        const dedupeKey = `${rule.type}:${lineNumber}:${match.index}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          violations.push({
            type: rule.type,
            ruleId: rule.type,
            line: lineNumber,
            excerpt: buildExcerpt(lineText, match),
            rule: rule.rule,
            description: rule.rule,
            autoFixable: rule.autoFixable,
          });
        }
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violationCount: violations.length,
    violations,
  };
}

function autoFix(html, scanResult) {
  if (typeof html !== 'string') throw new Error('html must be a string');
  const initialScan = scanResult || scanHtml(html);

  let fixed = html;
  fixed = fixed.replace(/(<img[^>]+src\s*=\s*["'])http:\/\//gi, '$1https://');
  fixed = fixed.replace(/(<iframe[^>]+src\s*=\s*["'])http:\/\//gi, '$1https://');
  fixed = fixed.replace(/<script[\s\S]*?<\/script>/gi, '<!-- [eBay Compliance: script removed] -->');
  fixed = fixed.replace(/<script\b[^>]*>/gi, '<!-- [eBay Compliance: script removed] -->');
  fixed = fixed.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');
  fixed = fixed.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '');
  fixed = fixed.replace(/<\/?form[^>]*>/gi, '<!-- [eBay Compliance: form removed] -->');
  fixed = fixed.replace(/<input[^>]*>/gi, '<!-- [eBay Compliance: input removed] -->');
  fixed = fixed.replace(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*>/gi,
    '<!-- [eBay Compliance: meta refresh removed] -->');
  fixed = fixed.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email removed]');
  fixed = fixed.replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, '[phone removed]');

  const afterScan = scanHtml(fixed);
  const fixedViolations = (initialScan.violations || []).filter(v =>
    v.autoFixable && !afterScan.violations.find(r => r.type === v.type && r.line === v.line));
  const remaining = afterScan.violations;

  return {
    html: fixed,
    fixedHtml: fixed,
    fixedRules: fixedViolations.map(v => v.type),
    fixed: fixedViolations,
    remaining,
    violations: remaining,
    compliant: remaining.length === 0
  };
}

function scanAllListings(listings) {
  if (!Array.isArray(listings)) throw new Error('listings must be an array');

  const results = listings.map(listing => {
    const details = (listing && listing.listingDetails) || {};
    return {
      id: listing.id || listing.sku,
      sku: listing.sku || listing.id,
      title: listing.title || details.title || '',
      scan: scanHtml(listing.description || details.description || ''),
    };
  });

  const compliantCount = results.filter(r => r.scan.compliant).length;

  return {
    totalListings: listings.length,
    compliantCount,
    violatingCount: listings.length - compliantCount,
    results,
  };
}

function getBadgeStatus(scanResult) {
  const list = Array.isArray(scanResult) ? scanResult : ((scanResult && scanResult.violations) || []);
  if (list.length === 0) return 'compliant';
  const hasUnfixable = list.some(v => !v.autoFixable);
  return hasUnfixable ? 'violations' : 'warnings';
}

module.exports = {
  scanHtml,
  autoFix,
  scanAllListings,
  getBadgeStatus,
  POLICY_RULES,
};
