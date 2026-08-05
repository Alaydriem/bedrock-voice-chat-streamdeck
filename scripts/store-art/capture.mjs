/**
 * Screenshot the store art at exact pixel sizes.
 *
 * The artboard page is the whole viewport, so a window-sized headless capture is
 * already the finished asset — no cropping, no scaling, no DPI surprise. Each frame
 * is addressed by `t`, and the page is a pure function of it, so re-running this
 * reproduces the same PNGs rather than whatever the animation happened to be doing.
 *
 * Usage:  node scripts/store-art/capture.mjs <outDir> [size] [t...]
 *   node scripts/store-art/capture.mjs ./out            # 512, a strip of 8 frames
 *   node scripts/store-art/capture.mjs ./out 256 3.5    # one 256 frame at t=3.5s
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find(existsSync);

if (!CHROME) throw new Error("No Chrome or Edge found to render with.");

const outDir = resolve(process.argv[2] ?? "./out");
const size = Number(process.argv[3] ?? 512);
/**
 * The dance is two sines beating: periods of ~2.33s and ~5.24s. Sampling across the
 * slower one covers the full range of shapes the mark takes, so eight frames is enough
 * to choose from rather than a lucky dip.
 */
const times = process.argv.length > 4 ? process.argv.slice(4).map(Number) : [0, 0.7, 1.4, 2.1, 2.8, 3.5, 4.2, 4.9];

mkdirSync(outDir, { recursive: true });

const page = pathToFileURL(resolve(import.meta.dirname, "index.html")).href;

for (const t of times) {
  const out = resolve(outDir, `bvc-mark-${size}-t${t.toFixed(2)}.png`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      // Without this a hi-DPI host silently doubles the capture.
      "--force-device-scale-factor=1",
      // Lets ?bg=transparent actually produce alpha rather than white.
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      "--virtual-time-budget=1500",
      `${page}?w=${size}&h=${size}&t=${t}`,
    ],
    { stdio: "pipe" },
  );
  console.log(`  ${out}`);
}

console.log(`\n${times.length} frame(s) at ${size}x${size}.`);
