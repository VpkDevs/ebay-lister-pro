/**
 * @file lib/complianceScanner.js
 * @description Non-destructive eBay Active Content Policy compliance scanner.
 *   Scans listing HTML descriptions for policy violations (external JS, HTTP image
 *   sources, iframes, Flash, etc.) and reports them with line-level context.
 *   Offers opt-in auto-fix that shows a diff before applying.
 */

'use strict';

/**
 * @typedef {Object} ComplianceViolation
 * @property {string} type      - Violation category key (e.g. 'SCRIPT_TAG')
 * @property {number} line      - 1-indexed line number in the HTML
 * @property {string} excerpt   - The offending HTML snippet (max 120 chars)
 * @property {string} rule      - Human-readable policy rule description
 * @property {boolean} autoFixable - Whether the auto-fixer can resolve this
 */

/**
 * @typedef {Object} ScanResult
 * @property {boolean} compliant            - True if zero violations
 * @property {number} violationCount
 * @property {ComplianceViolation[]} violations
 */

/**
 * @typedef {Object} AutoFixResult
 * @property {string} fixedHtml
 * @property {ComplianceViolation[]} fixed    - Violations that were corrected
 * @property {ComplianceViolation[]} remaining - Violations that could not be auto-fixed
 */

/**
 * eBay policy rules applied by the scanner.
 * Each rule has: type, pattern (RegExp), rule (description), autoFixable flag.
 * @type {Array<{type: string, pattern: RegExp, rule: string, autoFixable: boolean}>}
 */
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
];

/**
 * Returns a short excerpt of the offending content (max 120 chars).
 * @param {string} line - Full line text.
 * @param {RegExpMatchArray} match - The regex match.
 * @returns {string}
 */
function buildExcerpt(line, match) {
  const start = Math.max(0, match.index - 20);
  const end = Math.min(line.length, match.index + match[0].length + 40);
  let excerpt = line.slice(start, end).trim();
  if (excerpt.length > 120) excerpt = excerpt.slice(0, 117) + '...';
  return excerpt;
}

/**
 * Scans an HTML string for eBay Active Content Policy violations.
 * @param {string} html - The listing description HTML.
 * @returns {ScanResult}
 */
function scanHtml(html) {
  if (typeof html !== 'string') {
    return { compliant: true, violationCount: 0, violations: [] };
  }

  const lines = html.split('\n');
  /** @type {ComplianceViolation[]} */
  const violations = [];
  // Track deduplicated (type + lineNumber) pairs to avoid flooding on repeated matches
  const seen = new Set();

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNumber = lineIdx + 1;
    const lineText = lines[lineIdx];

    for (const rule of POLICY_RULES) {
      // Reset lastIndex for global regexes
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(lineText)) !== null) {
        const dedupeKey = `${rule.type}:${lineNumber}:${match.index}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          violations.push({
            type: rule.type,
            line: lineNumber,
            excerpt: buildExcerpt(lineText, match),
            rule: rule.rule,
            autoFixable: rule.autoFixable,
          });
        }
        // Prevent infinite loops on zero-length matches
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

/**
 * Applies auto-fixes to the HTML for all auto-fixable violations.
 * Non-fixable violations are left in `remaining`.
 * @param {string} html - The original listing description HTML.
 * @param {ScanResult} scanResult - A result from scanHtml().
 * @returns {AutoFixResult}
 */
function autoFix(html, scanResult) {
  if (typeof html !== 'string') throw new Error('html must be a string');

  let fixed = html;

  // Apply fixes in order of rule type to avoid double-processing
  // 1. Upgrade HTTP image sources → HTTPS
  fixed = fixed.replace(/(<img[^>]+src\s*=\s*["'])http:\/\//gi, '$1https://');

  // 2. Upgrade HTTP iframe sources → HTTPS
  fixed = fixed.replace(/(<iframe[^>]+src\s*=\s*["'])http:\/\//gi, '$1https://');

  // 3. Remove <script>...</script> blocks entirely
  fixed = fixed.replace(/<script[\s\S]*?<\/script>/gi, '<!-- [eBay Compliance: script removed] -->');

  // 4. Remove standalone <script> open tags (unclosed)
  fixed = fixed.replace(/<script\b[^>]*>/gi, '<!-- [eBay Compliance: script removed] -->');

  // 5. Replace javascript: hrefs with #
  fixed = fixed.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');

  // 6. Remove inline event handlers
  fixed = fixed.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '');

  // 7. Remove <form> tags (opening and closing)
  fixed = fixed.replace(/<\/?form[^>]*>/gi, '<!-- [eBay Compliance: form removed] -->');

  // 8. Remove <input> tags
  fixed = fixed.replace(/<input[^>]*>/gi, '<!-- [eBay Compliance: input removed] -->');

  // 9. Remove meta refresh
  fixed = fixed.replace(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*>/gi,
    '<!-- [eBay Compliance: meta refresh removed] -->');

  // Re-scan to classify what was fixed vs what remains
  const afterScan = scanHtml(fixed);
  const fixedViolations = scanResult.violations.filter(v =>
    v.autoFixable && !afterScan.violations.find(r => r.type === v.type && r.line === v.line));
  const remaining = afterScan.violations;

  return { fixedHtml: fixed, fixed: fixedViolations, remaining };
}

/**
 * Scans multiple listings and returns a compliance summary report.
 * @param {Array<{id: string, title: string, description: string}>} listings
 * @returns {{ totalListings: number, compliantCount: number, violatingCount: number, results: Array<{id, title, scan: ScanResult}> }}
 */
function scanAllListings(listings) {
  if (!Array.isArray(listings)) throw new Error('listings must be an array');

  const results = listings.map(listing => ({
    id: listing.id,
    title: listing.title || '',
    scan: scanHtml(listing.description || ''),
  }));

  const compliantCount = results.filter(r => r.scan.compliant).length;

  return {
    totalListings: listings.length,
    compliantCount,
    violatingCount: listings.length - compliantCount,
    results,
  };
}

/**
 * Returns the compliance badge label for a listing.
 * @param {ScanResult} scanResult
 * @returns {'compliant'|'warnings'|'violations'}
 */
function getBadgeStatus(scanResult) {
  if (scanResult.violationCount === 0) return 'compliant';
  const hasUnfixable = scanResult.violations.some(v => !v.autoFixable);
  return hasUnfixable ? 'violations' : 'warnings';
}

module.exports = {
  scanHtml,
  autoFix,
  scanAllListings,
  getBadgeStatus,
  POLICY_RULES,
};
