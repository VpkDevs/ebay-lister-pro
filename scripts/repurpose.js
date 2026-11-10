#!/usr/bin/env node
/**
 * repurpose.js — Atlas Phase 6 content repurposing engine.
 * (The module spec names repurpose.ts; this codebase is CommonJS Node, so
 * the script ships as .js to run with zero build step.)
 *
 * Takes a pillar post (markdown) and emits derivative drafts:
 *   1. an X thread (hook + one post per H2 section + CTA)
 *   2. a short post (first ~240 chars of the intro, tightened)
 *   3. a newsletter section (intro + section bullets + link line)
 *
 * Usage: node scripts/repurpose.js <pillar.md> [productUrl]
 * Output: markdown to stdout. Drafts, not auto-posts — a human fires them.
 */
'use strict';
const fs = require('fs');

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/repurpose.js <pillar.md> [productUrl]'); process.exit(1); }
  const url = process.argv[3] || '';
  const md = fs.readFileSync(file, 'utf8');
  const title = (md.match(/^#\s+(.+)$/m) || [null, 'Untitled'])[1].trim();
  const sections = [];
  const re = /^##\s+(.+)$/gm;
  let m;
  while ((m = re.exec(md)) !== null) sections.push(m[1].trim());
  const intro = md.split(/^##\s+/m)[0].replace(/^#.*$/m, '').trim().replace(/\s+/g, ' ');

  const out = [];
  out.push(`# Repurposed derivatives — "${title}"\n`);
  out.push('## X thread');
  out.push(`1/ ${title} — the full version is linked at the end. What I actually learned writing it:`);
  sections.slice(0, 5).forEach((s, i) => out.push(`${i + 2}/ ${s}`));
  out.push(`${Math.min(sections.length, 5) + 2}/ Full piece${url ? `: ${url}` : ' (link the pillar post here)'}. Replies with your numbers are the best part of these.`);
  out.push('\n## Short post');
  out.push(intro.length > 240 ? intro.slice(0, 237).trimEnd() + '…' : intro);
  out.push('\n## Newsletter section');
  out.push(`### ${title}`);
  out.push(intro);
  sections.forEach(s => out.push(`- ${s}`));
  out.push(url ? `\nRead the full piece: ${url}` : '\n(link the pillar post)');
  console.log(out.join('\n'));
}
main();
