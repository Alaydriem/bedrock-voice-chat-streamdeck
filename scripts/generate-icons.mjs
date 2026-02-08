/**
 * Generate static PNG action icons from the Lucide base SVGs.
 *
 * Per action we generate:
 *   icon.png / icon@2x.png           — action-list icon (white, uses the "on" SVG)
 *   key.png / key@2x.png             — manifest default = disconnected (gray)
 *   key-on.png / key-on@2x.png       — active/on state
 *   key-off.png / key-off@2x.png     — toggled off state
 *   key-disconnected.png / …@2x.png  — disconnected (gray) — same as key.png
 *
 * Usage:  node scripts/generate-icons.mjs
 */

import sharp from "sharp";
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
  const ratio = size <= 40 ? 0.6 : 0.5;
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

async function renderPng(innerElements, size, color) {
  const svg = buildSvg(innerElements, size, color);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function writePng(outDir, name, size, buf) {
  const outPath = join(outDir, name);
  writeFileSync(outPath, buf);
  console.log(`  ${outPath} (${size}x${size}, ${buf.length} bytes)`);
}

async function main() {
  for (const action of actions) {
    const outDir = join(SD_PLUGIN, "imgs", "actions", action.name);
    mkdirSync(outDir, { recursive: true });

    // --- Action-list icons (icon.png / icon@2x.png) — always white, "on" shape ---
    const iconInner = extractInner(readFileSync(join(baseDir, action.icon), "utf-8"));
    for (const [size, suffix] of [[20, ""], [40, "@2x"]]) {
      const buf = await renderPng(iconInner, size, WHITE);
      await writePng(outDir, `icon${suffix}.png`, size, buf);
    }

    // --- Key images for each state ---
    for (const state of action.states) {
      const inner = extractInner(readFileSync(join(baseDir, state.svg), "utf-8"));
      for (const [size, suffix] of [[72, ""], [144, "@2x"]]) {
        const buf = await renderPng(inner, size, state.color);
        await writePng(outDir, `${state.prefix}${suffix}.png`, size, buf);
      }
    }

    // --- key.png / key@2x.png = manifest default = disconnected state ---
    // Copy the disconnected images as key.png / key@2x.png
    const disconnected = action.states.find((s) => s.prefix === "key-disconnected");
    const discInner = extractInner(readFileSync(join(baseDir, disconnected.svg), "utf-8"));
    for (const [size, suffix] of [[72, ""], [144, "@2x"]]) {
      const buf = await renderPng(discInner, size, disconnected.color);
      await writePng(outDir, `key${suffix}.png`, size, buf);
    }
  }
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
