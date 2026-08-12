import type { StatCell, StatTone, StatView } from "./stat-view";

const SIZE = 144;
const BACKGROUND = "#19102f";
const VALUE_COLOUR = "#fbf8ff";
const LABEL_COLOUR = "#d6cbea";
const ALARM_COLOUR = "#ff8266";
const LABEL_OPACITY = 0.6;

/**
 * A generic stack, not a named font.
 *
 * The Stream Deck app rasterises this SVG with system fonts. A family absent on macOS would
 * fall back to something else and shift every position in the layout.
 */
const FONT = "Arial, Helvetica, sans-serif";

/** Above this many characters a message drops a size so it still fits across the key. */
const LONG_MESSAGE = 7;

/** Above this many characters the value drops a size rather than run past the key edge. */
const LONG_VALUE = 5;

interface TextOptions {
  x: number;
  y: number;
  size: number;
  colour: string;
  anchor: "start" | "middle" | "end";
  content: string;
  opacity?: number;
  bold?: boolean;
}

/**
 * Escape text for XML.
 *
 * Values carry names the user chose — a capture device, a server. An unescaped ampersand makes
 * the whole document unparseable, and the key goes blank rather than slightly wrong.
 */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function text(options: TextOptions): string {
  const opacity = options.opacity === undefined ? "" : ` opacity="${options.opacity}"`;
  const weight = options.bold === true ? ' font-weight="bold"' : "";
  return (
    `<text x="${options.x}" y="${options.y}" font-family="${FONT}"` +
    ` font-size="${options.size}" fill="${options.colour}"` +
    ` text-anchor="${options.anchor}"${opacity}${weight}>` +
    `${escapeXml(options.content)}</text>`
  );
}

function messageBody(content: string, tone: StatTone): string {
  return text({
    x: 72,
    y: 80,
    size: content.length > LONG_MESSAGE ? 18 : 24,
    colour: tone === "alarm" ? ALARM_COLOUR : LABEL_COLOUR,
    anchor: "middle",
    bold: true,
    content,
  });
}

/** The stat gets the whole key: a label, a large value, and the unit on its own line. */
function cellBody(cell: StatCell): string {
  const unit = cell.unit === ""
    ? ""
    : text({
        x: 72, y: 120, size: 20, colour: LABEL_COLOUR, anchor: "middle",
        opacity: LABEL_OPACITY, content: cell.unit,
      });

  return (
    text({
      x: 72, y: 40, size: 20, colour: LABEL_COLOUR, anchor: "middle",
      opacity: LABEL_OPACITY, content: cell.label,
    }) +
    text({
      // A long value would run past the key edge at the full size, and a device name is
      // arbitrarily long, so the size steps down rather than the text being cut.
      x: 72, y: 92, size: cell.value.length > LONG_VALUE ? 30 : 46,
      colour: VALUE_COLOUR, anchor: "middle", bold: true, content: cell.value,
    }) +
    unit
  );
}

/**
 * The key image for a view.
 *
 * Pure: the same view always produces the same string, which is what lets the action skip a
 * `setImage` that would change nothing.
 */
export function renderStatKey(view: StatView): string {
  const body = view.kind === "message"
    ? messageBody(view.text, view.tone)
    : cellBody(view.cell);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"` +
    ` viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${BACKGROUND}"/>` +
    `${body}</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
