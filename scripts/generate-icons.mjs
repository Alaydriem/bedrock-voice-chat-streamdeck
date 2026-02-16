/**
 * Generate SVG action icons from the Lucide base SVGs.
 *
 * Per action we generate:
 *   icon.svg               — action-list icon (white, uses the "on" SVG)
 *   key.svg                — manifest default = disconnected (gray)
 *   key-on.svg             — active/on state
 *   key-off.svg            — toggled off state
 *   key-disconnected.svg   — disconnected (gray) — same as key.svg
 *
 * SVGs are resolution-independent so @2x variants are not needed.
 *
 * Usage:  node scripts/generate-icons.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SD_PLUGIN =
  "com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin";
const baseDir = join(SD_PLUGIN, "imgs", "base");

const WHITE = "#FFFFFF";
const GRAY = "#666666";
const RED = "#FF4444";

// For each action, define every state: { svg file, stroke color, key prefix }
const actions = [
  {
    name: "mute",
    icon: "mic.svg",          // action-list icon always uses the "on" shape
    states: [
      { svg: "mic.svg",     color: WHITE, prefix: "key-on" },
      { svg: "mic-off.svg", color: WHITE, prefix: "key-off" },
      { svg: "mic.svg",     color: GRAY,  prefix: "key-disconnected" },
    ],
  },
  {
    name: "deafen",
    icon: "volume-2.svg",
    states: [
      { svg: "volume-2.svg",   color: WHITE, prefix: "key-on" },
      { svg: "volume-off.svg", color: WHITE, prefix: "key-off" },
      { svg: "volume-2.svg",   color: GRAY,  prefix: "key-disconnected" },
    ],
  },
  {
    name: "record",
    icon: "circle.svg",
    states: [
      { svg: "disc.svg",   color: RED,   prefix: "key-on" },
      { svg: "circle.svg", color: WHITE, prefix: "key-off" },
      { svg: "circle.svg", color: GRAY,  prefix: "key-disconnected" },
    ],
  },
];

// Extract inner elements from a Lucide SVG (strip outer <svg> tag)
function extractInner(svgString) {
  return svgString.replace(/<svg[^>]*>/, "").replace(/<\/svg>/, "").trim();
}

/**
 * Build a sized SVG from 24x24 Lucide inner elements.
 * Icon is centered with padding inside the target square.
 */
function buildSvg(innerElements, size, color) {
  // Action-list: 69% ratio; Key: 57.5% ratio (~15% larger than previous)
  const ratio = size <= 40 ? 0.69 : 0.575;
  const glyphSize = Math.round(size * ratio);
  const offset = Math.round((size - glyphSize) / 2);
  const scale = glyphSize / 24;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="translate(${offset},${offset}) scale(${scale})"
     stroke="${color}" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    ${innerElements}
  </g>
</svg>`;
}

function writeSvg(outDir, name, size, svg) {
  const outPath = join(outDir, name);
  writeFileSync(outPath, svg, "utf-8");
  console.log(`  ${outPath} (${size}x${size})`);
}

function main() {
  for (const action of actions) {
    const outDir = join(SD_PLUGIN, "imgs", "actions", action.name);
    mkdirSync(outDir, { recursive: true });

    // --- Action-list icon (icon.svg) — always white, "on" shape ---
    const iconInner = extractInner(readFileSync(join(baseDir, action.icon), "utf-8"));
    const iconSvg = buildSvg(iconInner, 20, WHITE);
    writeSvg(outDir, "icon.svg", 20, iconSvg);

    // --- Key images for each state ---
    for (const state of action.states) {
      const inner = extractInner(readFileSync(join(baseDir, state.svg), "utf-8"));
      const svg = buildSvg(inner, 144, state.color);
      writeSvg(outDir, `${state.prefix}.svg`, 144, svg);
    }

    // --- key.svg = manifest default = disconnected state ---
    const disconnected = action.states.find((s) => s.prefix === "key-disconnected");
    const discInner = extractInner(readFileSync(join(baseDir, disconnected.svg), "utf-8"));
    const keySvg = buildSvg(discInner, 144, disconnected.color);
    writeSvg(outDir, "key.svg", 144, keySvg);
  }
  console.log("\nDone.");
}

main();
