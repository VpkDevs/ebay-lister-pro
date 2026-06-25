/**
 * @file repurpose.js
 * @description Content Repurposing Engine for Phase 6. Takes a pillar post draft and formats it into multiple channels.
 */

const fs = require('fs');
const path = require('path');

function repurposePillarText(title, valuePoints, ctaUrl) {
  const cleanTitle = title.trim();
  const points = valuePoints.map(p => p.trim());
  const url = ctaUrl.trim();

  // 1. Format for Twitter/X Thread
  let twitterThread = `🧵 NEW PILLAR: ${cleanTitle}\n\nHere is what you need to know:\n\n`;
  points.forEach((p, idx) => {
    twitterThread += `${idx + 1}/ ${p}\n\n`;
  });
  twitterThread += `Read the full guide here: ${url}`;

  // 2. Format for LinkedIn (Long-form)
  let linkedinPost = `⚡ ${cleanTitle.toUpperCase()} ⚡\n\n`;
  linkedinPost += `Reselling inventory across platforms is painful. Success comes down to focus and data control.\n\n`;
  linkedinPost += `Here are the key takeaways:\n\n`;
  points.forEach(p => {
    linkedinPost += `👉 ${p}\n`;
  });
  linkedinPost += `\nWhat is your experience managing cross-listing feeds? Let's discuss in the comments.\n\n`;
  linkedinPost += `Learn more about local-first cross-listing: ${url}`;

  // 3. Format for Instagram/Carousel text
  let instagramPost = `⚡ ${cleanTitle} ⚡\n\n`;
  points.forEach((p, idx) => {
    instagramPost += `Slide ${idx + 2}: ${p}\n`;
  });
  instagramPost += `\n🔗 Link in Bio to read more: ${url}\n\n#reselling #ebaylister #shopify #dropshipping #ecommerce`;

  return {
    twitterThread,
    linkedinPost,
    instagramPost
  };
}

// CLI Execution Support
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: node scripts/repurpose.js \"<Pillar Title>\" \"<Point1|Point2|Point3>\" \"<CTA URL>\"");
    process.exit(1);
  }

  const title = args[0] || "Zero-Dependency Multi-Channel Lister";
  const rawPoints = args[1] || "Eliminate package bloat|Keep store credentials local|Concurrently upload to major platforms";
  const url = args[2] || "https://ebaylisterpro.com";

  const points = rawPoints.split('|');
  const results = repurposePillarText(title, points, url);

  console.log("\n======================================================");
  console.log("🐦 TWITTER/X THREAD DRAFT");
  console.log("======================================================");
  console.log(results.twitterThread);

  console.log("\n======================================================");
  console.log("💼 LINKEDIN LONG-FORM DRAFT");
  console.log("======================================================");
  console.log(results.linkedinPost);

  console.log("\n======================================================");
  console.log("📸 INSTAGRAM CAROUSEL TEXT DRAFT");
  console.log("======================================================");
  console.log(results.instagramPost);
  console.log("======================================================\n");
}

module.exports = { repurposePillarText };
