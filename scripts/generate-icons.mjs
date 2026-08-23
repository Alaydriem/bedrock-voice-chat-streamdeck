/**
 * Generate the action SVGs from the BVC radial design system.
 *
 * The keys are the dashboard's self-pill buttons, redrawn at key size. That means the
 * glyphs and the colours are not approximations of the dashboard — they are the same
 * values, copied from `bvc-radial-login/client/src/radial`:
 *
 *   glyphs  radial/core/icons/Icons.ts   (RAD_ICONS)
 *   colours radial/css/tokens.css        (--color-rad-*)
 *   states  radial/css/components/dashboard.css  (.rad-self__btn)
 *
 * The dashboard rule is "filled, not tinted": an engaged control floods with its
 * semantic colour and the glyph flips dark against it, so the whole thing reads as one
 * coloured object rather than a coloured box holding a pale icon. On a key there is no
 * surrounding pill to sit inside, so the fill is the whole key.
 *
 * Per action we generate:
 *   icon.svg               — action-list icon (bare glyph, no ground)
 *   key.svg                — manifest default = disconnected
 *   key-on.svg             — active/on state
 *   key-off.svg            — toggled off state
 *   key-disconnected.svg   — BVC unreachable
 *
 * SVGs are resolution-independent so @2x variants are not needed.
 *
 * Usage:  node scripts/generate-icons.mjs
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const SD_PLUGIN = "com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin";

// --- Tokens (radial/css/tokens.css) -----------------------------------------

const VOID = "#1c1132"; // --color-rad-void  — the app ground, and the glyph on a fill
const VOID_2 = "#251844"; // --color-rad-void-2
const DIM = "#d6cbea"; // --color-rad-dim   — the glyph at rest
const TX = "#fbf8ff"; // --color-rad-tx    — action list, against Stream Deck's own chrome
const WARN = "#ffcf4d"; // --color-rad-warn  — deafen: you chose it, one press undoes it
const FAULT = "#ff8266"; // --color-rad-fault — muted, and recording

// --- Grounds ----------------------------------------------------------------
//
// The dashboard states its button grounds as translucent layers, so there is no hex in
// the theme to copy for "a button at rest" — the colour only exists once the stack is
// composited. A key is opaque and has no stack, so we run the same composite the browser
// runs and bake the result in. Reading a colour off a screenshot would drift; this cannot.
//
//   void                                    --color-rad-void
//     └ .rad-self-pill   rgb(37 24 68 / .95)   dashboard.css:1003
//         └ .rad-self__btn  rgb(20 12 38 / .68) dashboard.css:1100
//             └ recording    rgb(255 130 102 / .22)  dashboard.css:1182

/** Composite `rgb(hex / alpha)` over an opaque backdrop, the way the browser would. */
function over([hex, alpha], backdrop) {
  const px = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [r1, g1, b1] = px(hex);
  const [r2, g2, b2] = px(backdrop);
  const mix = (a, b) => Math.round(alpha * a + (1 - alpha) * b);
  return (
    "#" +
    [mix(r1, r2), mix(g1, g2), mix(b1, b2)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

const PILL = over([VOID_2, 0.95], VOID);
/** A control that is not engaged. Resolves to #19102f. */
const REST = over(["#140c26", 0.68], PILL);
/**
 * Recording is a wash, not a fill. Resolves to #4c293b.
 *
 * Mute and deafen fill solid and flip the glyph dark; recording does not, because the
 * dashboard's record control also has to carry a legible timer inside it. Filling it
 * coral would leave that text on coral. So this state inverts: the ground stays dark and
 * the glyph takes the colour.
 */
const RECORDING = over([FAULT, 0.22], REST);

/** The theme greys unavailable controls rather than hiding them. button.css:70, control.css:82. */
const DISABLED_OPACITY = 0.4;

// --- Glyphs (radial/core/icons/Icons.ts) ------------------------------------
// One 24x24 box, 1.9 stroke, round caps. Copied verbatim so a mic here and a mic on
// the dashboard are the same drawing.

const RAD_ICONS = {
  mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.5"/>',
  micoff:
    '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.5"/><path d="M4 3l16 18"/>',
  head: '<path d="M4 15.5v-3.5a8 8 0 0 1 16 0v3.5"/><rect x="2.5" y="14" width="4.6" height="7.2" rx="2.3"/><rect x="16.9" y="14" width="4.6" height="7.2" rx="2.3"/>',
  headoff:
    '<path d="M4 15.5v-3.5a8 8 0 0 1 16 0v3.5"/><rect x="2.5" y="14" width="4.6" height="7.2" rx="2.3"/><rect x="16.9" y="14" width="4.6" height="7.2" rx="2.3"/><path d="M3 2.5l18 19"/>',
  rec: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/>',
  /**
   * Not in RAD_ICONS: the dashboard's record button has no unreachable state, because a
   * dashboard that cannot reach the client does not render. The slash follows the angle
   * `micoff` and `headoff` already use, so the three disconnected keys read as one idea.
   */
  recoff:
    '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/><path d="M4 4l16 16"/>',
};

const STROKE_WIDTH = 1.9;

/**
 * Glyph as a share of the key. The dashboard runs a 19px glyph in a 42px button (0.452);
 * a hair larger here because the key has no surrounding chrome to give the glyph its edge.
 */
const KEY_GLYPH_RATIO = 0.48;
const ICON_GLYPH_RATIO = 0.69;

/** The state each key image represents, in the dashboard's own terms. */
const actions = [
  {
    name: "mute",
    icon: "mic",
    states: [
      // Live. Nothing is engaged, so nothing is filled.
      { prefix: "key-on", glyph: "mic", ground: REST, color: DIM },
      // Muted: fault, because "nobody can hear you" is not a preference.
      { prefix: "key-off", glyph: "micoff", ground: FAULT, color: VOID },
      { prefix: "key-disconnected", glyph: "micoff", ground: REST, color: DIM, faded: true },
    ],
  },
  {
    name: "deafen",
    icon: "head",
    states: [
      { prefix: "key-on", glyph: "head", ground: REST, color: DIM },
      // Warn, not fault: you chose it, and it is recoverable in one press.
      { prefix: "key-off", glyph: "headoff", ground: WARN, color: VOID },
      { prefix: "key-disconnected", glyph: "headoff", ground: REST, color: DIM, faded: true },
    ],
  },
  {
    name: "record",
    icon: "rec",
    states: [
      { prefix: "key-on", glyph: "rec", ground: RECORDING, color: FAULT },
      { prefix: "key-off", glyph: "rec", ground: REST, color: DIM },
      { prefix: "key-disconnected", glyph: "recoff", ground: REST, color: DIM, faded: true },
    ],
  },
];

/**
 * Resolve `currentColor` up front rather than leaning on the renderer to inherit it.
 * `rec` fills its centre that way, and a standalone SVG file has no cascade to inherit from.
 */
function paint(inner, color) {
  return inner.replaceAll("currentColor", color);
}

/**
 * Compose one image: an optional full-bleed ground, then the glyph centred on top.
 * The glyph keeps its 1.9 stroke and is scaled by the transform, so its weight stays in
 * proportion exactly as it does on the dashboard.
 */
function buildSvg({ glyph, size, ratio, color, ground, faded }) {
  const glyphSize = Math.round(size * ratio);
  const offset = Math.round((size - glyphSize) / 2);
  const scale = glyphSize / 24;

  const bg = ground ? `\n  <rect width="${size}" height="${size}" fill="${ground}"/>` : "";
  const opacity = faded ? ` opacity="${DISABLED_OPACITY}"` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}
  <g transform="translate(${offset},${offset}) scale(${scale})"${opacity}
     stroke="${color}" stroke-width="${STROKE_WIDTH}"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    ${paint(RAD_ICONS[glyph], color)}
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

    // Action list: no ground. It sits on Stream Deck's own chrome, and a violet tile
    // there would read as a swatch rather than as this plugin's mic.
    writeSvg(
      outDir,
      "icon.svg",
      20,
      buildSvg({ glyph: action.icon, size: 20, ratio: ICON_GLYPH_RATIO, color: TX }),
    );

    for (const state of action.states) {
      writeSvg(
        outDir,
        `${state.prefix}.svg`,
        144,
        buildSvg({ ...state, size: 144, ratio: KEY_GLYPH_RATIO }),
      );
    }

    // key.svg = the manifest default, before the plugin has said anything.
    const disconnected = action.states.find((s) => s.prefix === "key-disconnected");
    writeSvg(
      outDir,
      "key.svg",
      144,
      buildSvg({ ...disconnected, size: 144, ratio: KEY_GLYPH_RATIO }),
    );
  }
  console.log("\nDone.");
}

main();
