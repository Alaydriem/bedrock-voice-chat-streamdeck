# Jukebox and Stat Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two Stream Deck keys — a jukebox mute toggle on the existing command socket, and a stat key that draws up to four live numbers taken from the client's `/metrics` push stream.

**Architecture:** The plugin's shape does not change. A singleton owns a socket and mirrors what the client reports; actions subscribe and redraw. The jukebox key extends the existing `wsManager` path. The stat key adds a second singleton, `metricsManager`, for the push-only `/metrics` route, and everything that can be wrong is pulled into pure modules that unit test with no socket and no Stream Deck SDK: frame parsing, path discovery, formatting, the draw decision, the SVG, and the reference counting. The transport shells (`ws-manager.ts`, `metrics-manager.ts`) stay thin and untested, exactly as they are today.

**Tech Stack:** TypeScript (ES2022, `moduleResolution: Bundler`), `@elgato/streamdeck` v2, `ws` v8, Rollup, sdpi-components v4 for the Property Inspector, Vitest for unit tests.

**Design spec:** `docs/superpowers/specs/2026-08-11-jukebox-and-stat-keys-design.md`

## Global Constraints

- **The auth key is mandatory.** Command frames carry `key` in the body; the `/metrics` upgrade carries it in the query string. Without a key configured, neither socket opens.
- **Wire field names are snake_case** (`jukebox_muted`, `rtt_ms`, `captured_at_ms`). TypeScript-side names are camelCase. The boundary is `frame.ts` and `metrics-frame.ts` and nowhere else — except stat paths, which stay in their wire form on purpose, because they are data the user selects rather than names the code reads.
- **Nothing is drawn optimistically.** A key changes only when the client reports something.
- **A stale number is never drawn.** Values older than `STALE_AFTER_MS` (3000) draw as `—`.
- **No `console.log`.** Use `streamDeck.logger`.
- **No new colours.** The palette is the redesign's: background `#19102f`, outline `#d6cbea`, value `#fbf8ff`, alarm `#ff8266`, inverted stroke `#1c1132`.
- **Style:** camelCase values and functions, PascalCase types, UPPER_SNAKE_CASE constants, `interface` for object shapes, `type` for unions. No `any` — use `unknown` and narrow. Immutable updates. Files under 400 lines.
- **Commits:** conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `refactor:`). semantic-release reads these, so `feat:` and `fix:` cut releases.
- **Existing behaviour must not regress:** reconnect backoff, the 15 s ping keepalive, the 30 s stability reset, and the `User-Agent` on the upgrade request all stay as they are.

---

### Task 1: The jukebox in the protocol layer

The client added a `jukebox` command and a `jukebox_muted` field on the state frame. This task
teaches the frame parser and the state mirror about both, and nothing else. No key yet.

The parse order matters. Three response shapes carry `muted`:

| Shape | Meaning |
| --- | --- |
| `{device, muted}` | a mute reply |
| `{muted, deafened, recording, …}` | a full state frame |
| `{muted}` | a jukebox reply |

The jukebox shape is the barest of the three, so its arm goes last of the three. Placed first
it would swallow both of the others.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/frame.ts`
- Modify: `src/ws-manager.ts`
- Test: `tests/frame.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BvcCommand` gains the member `{ action: "jukebox" }`
  - `BvcState` gains `jukeboxMuted: boolean | null`
  - `BvcStateEvent` gains `{ type: "jukeboxMuteChanged"; muted: boolean | null }`
  - `StateFrameData` gains `jukeboxMuted: boolean`
  - `BvcFrame` gains `{ kind: "jukebox"; muted: boolean }`

- [ ] **Step 1: Write the failing tests**

Add these to `tests/frame.test.ts`, inside the existing `describe("parseFrame", …)` block,
after the `"reads a mute response…"` test:

```ts
  test("reads a jukebox response and does not mistake it for mute or state", () => {
    expect(parseFrame(wrap({ muted: true }))).toEqual({ kind: "jukebox", muted: true });
  });

  test("reads a jukebox response reporting music playing", () => {
    expect(parseFrame(wrap({ muted: false }))).toEqual({ kind: "jukebox", muted: false });
  });

  test("still reads a mute response, which also carries muted", () => {
    expect(parseFrame(wrap({ device: "output", muted: true }))).toEqual({
      kind: "mute", device: "output", muted: true,
    });
  });

  test("reads jukebox_muted from a state frame", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: false, recording: false,
      voice_mode: "openMic", ptt_active: false, jukebox_muted: true, connection: null,
    }));
    expect(frame.kind === "state" && frame.state.jukeboxMuted).toBe(true);
  });

  test("a state frame with no jukebox_muted reads as music playing", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: false, recording: false,
      voice_mode: "openMic", ptt_active: false, connection: null,
    }));
    expect(frame.kind === "state" && frame.state.jukeboxMuted).toBe(false);
  });
```

Now fix the two existing full-state tests, which assert with `toEqual` and will fail once the
field exists. In `"reads a full state frame with no active connection"`, add
`jukebox_muted: false` to the parsed object and `jukeboxMuted: false` to the expectation:

```ts
  test("reads a full state frame with no active connection", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: true, recording: false,
      voice_mode: "openMic", ptt_active: false, jukebox_muted: false, connection: null,
    }));
    expect(frame).toEqual({
      kind: "state",
      state: {
        muted: false, deafened: true, recording: false,
        voiceMode: "openMic", pttActive: false, jukeboxMuted: false, connection: null,
      },
    });
  });
```

And in `"reads a full state frame carrying an active connection"`:

```ts
  test("reads a full state frame carrying an active connection", () => {
    const frame = parseFrame(wrap({
      muted: true, deafened: false, recording: false,
      voice_mode: "pushToTalk", ptt_active: true, jukebox_muted: true,
      connection: { id: "realm:12345", name: "My Realm", kind: "realm" },
    }));
    expect(frame).toEqual({
      kind: "state",
      state: {
        muted: true, deafened: false, recording: false,
        voiceMode: "pushToTalk", pttActive: true, jukeboxMuted: true,
        connection: { id: "realm:12345", name: "My Realm", kind: "realm" },
      },
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test`
Expected: FAIL. The new jukebox tests report `kind` of `"unknown"`, and the two state tests
report a missing `jukeboxMuted`.

- [ ] **Step 3: Add the types**

In `src/types.ts`, add the command member to `BvcCommand`, after the `mute` member:

```ts
  | { action: "jukebox" }
```

Add the field to `BvcState`, after `pttActive`:

```ts
  jukeboxMuted: boolean | null;
```

And the event to `BvcStateEvent`, after `pttActiveChanged`:

```ts
  | { type: "jukeboxMuteChanged"; muted: boolean | null }
```

- [ ] **Step 4: Teach the frame parser**

In `src/frame.ts`, add the field to `StateFrameData`, after `pttActive`:

```ts
  /** Whether jukebox music is silenced. A client predating the field reads as playing. */
  jukeboxMuted: boolean;
```

Add the frame member to `BvcFrame`, after the `mute` member:

```ts
  | { kind: "jukebox"; muted: boolean }
```

In `parseFrame`, add `jukeboxMuted` to the state arm's returned object, beside `pttActive`:

```ts
        pttActive: data.ptt_active === true,
        jukeboxMuted: data.jukebox_muted === true,
```

Then add the jukebox arm immediately after the state arm's closing brace, before the
`connected` check:

```ts
  // Last of the three shapes carrying `muted`: a mute reply carries `device` beside it and a
  // state frame carries `deafened` and `recording`, so both have already matched above.
  if (typeof data.muted === "boolean") return { kind: "jukebox", muted: data.muted };
```

- [ ] **Step 5: Mirror the state**

In `src/ws-manager.ts`, add the field to the `state` initialiser, after `pttActive: null`:

```ts
    jukeboxMuted: null,
```

Add an arm to `applyFrame`, after the `"ptt"` case:

```ts
      case "jukebox":
        this.setJukeboxMuted(frame.muted);
        return;
```

Add the line to `applyState`, after `setPttActive`:

```ts
    this.setJukeboxMuted(state.jukeboxMuted);
```

Add the line to `clearReportedState`, after `setPttActive(null)`:

```ts
    this.setJukeboxMuted(null);
```

And add the setter after `setPttActive`:

```ts
  private setJukeboxMuted(muted: boolean | null): void {
    if (this.state.jukeboxMuted === muted) return;
    this.state.jukeboxMuted = muted;
    this.emit({ type: "jukeboxMuteChanged", muted });
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn test`
Expected: PASS, all files.

- [ ] **Step 7: Verify the build typechecks**

Run: `yarn build`
Expected: no TypeScript errors. `BvcState` is constructed in exactly one place, so a missed
field would surface here.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/frame.ts src/ws-manager.ts tests/frame.test.ts
git commit -m "feat: read the jukebox command and jukebox_muted state"
```

---

### Task 2: The jukebox key

The key itself. A sibling of the Deafen key, which is the closest template in the repo.

**Files:**
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/jukebox/icon.svg`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/jukebox/key.svg`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/jukebox/key-on.svg`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/jukebox/key-off.svg`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/jukebox/key-disconnected.svg`
- Create: `src/actions/jukebox.ts`
- Modify: `src/icons.ts`
- Modify: `src/plugin.ts`
- Modify: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json`

**Interfaces:**
- Consumes: `BvcCommand`'s `{ action: "jukebox" }`, `BvcState.jukeboxMuted`, and the
  `jukeboxMuteChanged` event, all from Task 1.
- Produces: `JukeboxAction`, and `icons.jukeboxOn` / `icons.jukeboxOff` /
  `icons.jukeboxDisconnected`.

- [ ] **Step 1: Draw the art**

Five files. The glyph is a music note on the same 24-unit grid the other keys use, placed with
the same `translate(38,38) scale(2.875)` so it sits identically to the microphone and
headphones.

`imgs/actions/jukebox/key-on.svg` — music plays:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#19102f"/>
  <g transform="translate(38,38) scale(2.875)"
     stroke="#d6cbea" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
  </g>
</svg>
```

`imgs/actions/jukebox/key-off.svg` — music silenced. Inverted and filled, the treatment
`mute/key-off.svg` already uses for a muted control, plus a slash:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#ff8266"/>
  <g transform="translate(38,38) scale(2.875)"
     stroke="#1c1132" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M3 2.5l18 19"/>
  </g>
</svg>
```

`imgs/actions/jukebox/key-disconnected.svg` — dimmed, and deliberately without a slash. A slash
reads as "muted", which is a state this key knows nothing about while the client is unreachable:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#19102f"/>
  <g transform="translate(38,38) scale(2.875)" opacity="0.4"
     stroke="#d6cbea" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
  </g>
</svg>
```

`imgs/actions/jukebox/key.svg` — the manifest's static state, identical to the disconnected
variant, matching how `deafen/key.svg` mirrors `deafen/key-disconnected.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#19102f"/>
  <g transform="translate(38,38) scale(2.875)" opacity="0.4"
     stroke="#d6cbea" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
  </g>
</svg>
```

`imgs/actions/jukebox/icon.svg` — the action list entry, 20x20 on the shared scale:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
  <g transform="translate(3,3) scale(0.5833333333333334)"
     stroke="#fbf8ff" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
  </g>
</svg>
```

- [ ] **Step 2: Register the image paths**

In `src/icons.ts`, add after the `record*` block:

```ts
  jukeboxOn:              "imgs/actions/jukebox/key-on",
  jukeboxOff:             "imgs/actions/jukebox/key-off",
  jukeboxDisconnected:    "imgs/actions/jukebox/key-disconnected",
```

- [ ] **Step 3: Write the action**

Create `src/actions/jukebox.ts`:

```ts
import { action, KeyDownEvent, SingletonAction, WillAppearEvent } from "@elgato/streamdeck";
import type { ActionSettings } from "../types";
import { wsManager } from "../ws-manager";
import { icons } from "../icons";

/**
 * The jukebox key. A toggle, like Deafen.
 *
 * `jukebox` is a toggle rather than a setter on the client too, so the key sends the same
 * command whatever it is currently showing. The icon follows the frame that comes back, never
 * the press — a refused toggle must not leave the key claiming something the client did not do.
 */
@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.jukebox" })
export class JukeboxAction extends SingletonAction<ActionSettings> {
  private subscribed = false;

  override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      wsManager.on((event) => {
        if (event.type === "connectionChanged" || event.type === "jukeboxMuteChanged") {
          this.updateAllIcons();
        }
      });
    }
    if (ev.action.isKey()) {
      ev.action.setImage(this.getIcon());
    }
  }

  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const sent = wsManager.send(
      { action: "jukebox" },
      { onError: () => void ev.action.showAlert() },
    );
    if (!sent) {
      await ev.action.showAlert();
    }
  }

  private getIcon(): string {
    const s = wsManager.state;
    if (!s.connected || s.jukeboxMuted === null) return icons.jukeboxDisconnected;
    return s.jukeboxMuted ? icons.jukeboxOff : icons.jukeboxOn;
  }

  private updateAllIcons(): void {
    const icon = this.getIcon();
    for (const a of this.actions) {
      if (a.isKey()) a.setImage(icon);
    }
  }
}
```

- [ ] **Step 4: Register the action**

In `src/plugin.ts`, add the import after the `RecordAction` import:

```ts
import { JukeboxAction } from "./actions/jukebox";
```

and the registration after `RecordAction`'s:

```ts
streamDeck.actions.registerAction(new JukeboxAction());
```

- [ ] **Step 5: Add the manifest entry**

In `manifest.json`, add this object to the `Actions` array, after the Record entry:

```json
        {
            "Name": "Jukebox",
            "UUID": "com.alaydriem.bedrock-voice-chat.streamdeck.jukebox",
            "Icon": "imgs/actions/jukebox/icon",
            "Tooltip": "Toggle jukebox music in Bedrock Voice Chat",
            "Controllers": [
                "Keypad"
            ],
            "States": [
                {
                    "Image": "imgs/actions/jukebox/key",
                    "ShowTitle": false
                }
            ]
        },
```

Match the file's existing indentation. Keep the Connect entry last.

- [ ] **Step 6: Build and check the manifest is valid**

Run: `yarn build`
Expected: no TypeScript errors.

Run: `npx streamdeck validate com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin`
Expected: no errors. A missing image file or a malformed UUID is reported here.

- [ ] **Step 7: Try it against a running client**

Run: `npx streamdeck restart com.alaydriem.bedrock-voice-chat.streamdeck`

With Bedrock Voice Chat running, drag the Jukebox key onto the Stream Deck. Confirm three
things: the key shows the plain note while music is not silenced; pressing it silences the
music and the key turns to the filled variant; toggling the jukebox inside the app moves the
key without a press.

- [ ] **Step 8: Commit**

```bash
git add src/actions/jukebox.ts src/icons.ts src/plugin.ts \
  com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json \
  com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/jukebox
git commit -m "feat: add a jukebox mute key"
```

---

### Task 3: Shared connection settings

The metrics socket reads the same host, port and key as the command socket. Rather than a
second copy of the port parser, extract the one that exists.

This is a refactor with no behaviour change. It is its own task because it touches a working
file that nothing yet tests.

**Files:**
- Create: `src/connection-settings.ts`
- Modify: `src/ws-manager.ts:17-18,36-40,107-118`
- Test: `tests/connection-settings.test.ts`

**Interfaces:**
- Consumes: `GlobalSettings` from `src/types.ts`.
- Produces:
  - `DEFAULT_HOST = "127.0.0.1"`, `DEFAULT_PORT = 9595`
  - `interface ConnectionSettings { host: string; port: number; key: string }`
  - `parsePort(value: string | number | undefined): number`
  - `readConnection(settings: GlobalSettings): ConnectionSettings`
  - `sameConnection(a: ConnectionSettings, b: ConnectionSettings): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/connection-settings.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  parsePort,
  readConnection,
  sameConnection,
} from "../src/connection-settings";

describe("parsePort", () => {
  test("reads a numeric string", () => {
    expect(parsePort("9600")).toBe(9600);
  });

  test("reads a number", () => {
    expect(parsePort(9600)).toBe(9600);
  });

  test("falls back to the default for an empty value", () => {
    expect(parsePort("")).toBe(DEFAULT_PORT);
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
  });

  test("falls back to the default for text that is not a port", () => {
    expect(parsePort("nine thousand")).toBe(DEFAULT_PORT);
  });

  test("falls back to the default for a port outside the valid range", () => {
    expect(parsePort("0")).toBe(DEFAULT_PORT);
    expect(parsePort("70000")).toBe(DEFAULT_PORT);
  });
});

describe("readConnection", () => {
  test("reads all three values", () => {
    expect(readConnection({ host: "10.0.0.4", port: "9600", authenticationKey: "abc" })).toEqual({
      host: "10.0.0.4", port: 9600, key: "abc",
    });
  });

  test("trims whitespace around the host and the key", () => {
    expect(readConnection({ host: "  10.0.0.4 ", authenticationKey: " abc " })).toEqual({
      host: "10.0.0.4", port: DEFAULT_PORT, key: "abc",
    });
  });

  test("defaults an empty settings object", () => {
    expect(readConnection({})).toEqual({ host: DEFAULT_HOST, port: DEFAULT_PORT, key: "" });
  });

  test("a host of only whitespace is the default, not an empty host", () => {
    expect(readConnection({ host: "   " }).host).toBe(DEFAULT_HOST);
  });
});

describe("sameConnection", () => {
  const base = { host: "127.0.0.1", port: 9595, key: "abc" };

  test("equal values are the same connection", () => {
    expect(sameConnection(base, { ...base })).toBe(true);
  });

  test("a different key is a different connection", () => {
    expect(sameConnection(base, { ...base, key: "xyz" })).toBe(false);
  });

  test("a different port is a different connection", () => {
    expect(sameConnection(base, { ...base, port: 9600 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test tests/connection-settings.test.ts`
Expected: FAIL — cannot resolve `../src/connection-settings`.

- [ ] **Step 3: Write the module**

Create `src/connection-settings.ts`:

```ts
import type { GlobalSettings } from "./types";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 9595;

/** Where the client is, and the key it demands. Shared by both sockets. */
export interface ConnectionSettings {
  host: string;
  port: number;
  key: string;
}

/** Parse a port string, returning the default if empty or invalid. */
export function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const n = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

export function readConnection(settings: GlobalSettings): ConnectionSettings {
  return {
    host: settings.host?.trim() || DEFAULT_HOST,
    port: parsePort(settings.port),
    key: settings.authenticationKey?.trim() ?? "",
  };
}

/** Whether two readings describe the same endpoint, so a socket need not be reopened. */
export function sameConnection(a: ConnectionSettings, b: ConnectionSettings): boolean {
  return a.host === b.host && a.port === b.port && a.key === b.key;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test tests/connection-settings.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Point ws-manager at it**

In `src/ws-manager.ts`, delete the two constants:

```ts
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9595;
```

and delete the whole local `parsePort` function together with its doc comment:

```ts
/** Parse a port string, returning the default if empty/invalid. */
function parsePort(value: string | number | undefined): number {
  …
}
```

Add the import beside the others at the top of the file:

```ts
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  readConnection,
  sameConnection,
} from "./connection-settings";
```

Then replace the body of `applySettings` with:

```ts
  /** Apply settings, return true if connection-relevant values changed. */
  private applySettings(s: GlobalSettings): boolean {
    const next = readConnection(s);
    const changed = !sameConnection(next, {
      host: this.host,
      port: this.port,
      key: this.authenticationKey,
    });

    this.host = next.host;
    this.port = next.port;
    this.authenticationKey = next.key;
    return changed;
  }
```

The field initialisers `private host = DEFAULT_HOST;` and `private port = DEFAULT_PORT;` are
unchanged — they now read the imported constants.

- [ ] **Step 6: Run everything and build**

Run: `yarn test`
Expected: PASS, all files.

Run: `yarn build`
Expected: no TypeScript errors and no unused-import warnings.

- [ ] **Step 7: Commit**

```bash
git add src/connection-settings.ts src/ws-manager.ts tests/connection-settings.test.ts
git commit -m "refactor: share connection settings between sockets"
```

---

### Task 4: Metrics frame parsing

The `/metrics` route tags its frames with a `type`, so unlike `frame.ts` this parser does no
shape guessing. Two frame types matter: the snapshot, and the health verdict that explains why
snapshots stopped.

The snapshot is deliberately left as an untyped record. The plugin walks it rather than reading
named fields, which is what lets a stat added to the client appear without a plugin release.

**Files:**
- Create: `src/metrics-frame.ts`
- Test: `tests/metrics-frame.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Snapshot = Record<string, unknown>`
  - `type HealthState` — `{ status: "Connected" } | { status: "Reconnecting"; attempt: number } | { status: "Disconnected" } | { status: "Failed" } | { status: "VersionMismatch" } | { status: "Unauthorized" }`
  - `type MetricsFrame` — `{ kind: "metrics"; snapshot: Snapshot } | { kind: "health"; health: HealthState } | { kind: "unknown" }`
  - `parseMetricsFrame(raw: string): MetricsFrame`

- [ ] **Step 1: Write the failing test**

Create `tests/metrics-frame.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { parseMetricsFrame } from "../src/metrics-frame";

const metrics = (data: unknown): string => JSON.stringify({ type: "metrics", data });
const health = (data: unknown): string => JSON.stringify({ type: "health", data });

describe("parseMetricsFrame", () => {
  test("returns unknown for text that is not JSON", () => {
    expect(parseMetricsFrame("not json").kind).toBe("unknown");
  });

  test("returns unknown for a JSON array", () => {
    expect(parseMetricsFrame("[1,2,3]").kind).toBe("unknown");
  });

  test("returns unknown for a frame with no type", () => {
    expect(parseMetricsFrame(JSON.stringify({ data: { rtt_ms: 42 } })).kind).toBe("unknown");
  });

  test("returns unknown for a type it does not recognise", () => {
    expect(parseMetricsFrame(JSON.stringify({ type: "rollup", data: {} })).kind).toBe("unknown");
  });

  test("returns unknown for a frame with no data", () => {
    expect(parseMetricsFrame(JSON.stringify({ type: "metrics" })).kind).toBe("unknown");
  });

  test("reads a metrics frame and keeps the payload whole", () => {
    const frame = parseMetricsFrame(metrics({ link: { rtt_ms: 42 }, captured_at_ms: 1700 }));
    expect(frame).toEqual({
      kind: "metrics",
      snapshot: { link: { rtt_ms: 42 }, captured_at_ms: 1700 },
    });
  });

  test("reads a connected health frame", () => {
    expect(parseMetricsFrame(health({ status: "Connected" }))).toEqual({
      kind: "health", health: { status: "Connected" },
    });
  });

  test("reads a reconnecting health frame and keeps the attempt", () => {
    expect(parseMetricsFrame(health({ status: "Reconnecting", attempt: 3 }))).toEqual({
      kind: "health", health: { status: "Reconnecting", attempt: 3 },
    });
  });

  test("a reconnecting frame with no attempt reads as attempt zero", () => {
    expect(parseMetricsFrame(health({ status: "Reconnecting" }))).toEqual({
      kind: "health", health: { status: "Reconnecting", attempt: 0 },
    });
  });

  test("reads a disconnected health frame", () => {
    expect(parseMetricsFrame(health({ status: "Disconnected" }))).toEqual({
      kind: "health", health: { status: "Disconnected" },
    });
  });

  test("reads a failed health frame", () => {
    expect(parseMetricsFrame(health({ status: "Failed" }))).toEqual({
      kind: "health", health: { status: "Failed" },
    });
  });

  test("reads a version mismatch, dropping the versions it does not draw", () => {
    const raw = health({
      status: "VersionMismatch",
      client_version: "1.0.0", server_version: "2.0.0", client_too_old: true,
    });
    expect(parseMetricsFrame(raw)).toEqual({
      kind: "health", health: { status: "VersionMismatch" },
    });
  });

  test("reads an unauthorized health frame, dropping the reason it does not draw", () => {
    const raw = health({ status: "Unauthorized", reason: "certificate rejected" });
    expect(parseMetricsFrame(raw)).toEqual({
      kind: "health", health: { status: "Unauthorized" },
    });
  });

  test("returns unknown for a health status it does not recognise", () => {
    expect(parseMetricsFrame(health({ status: "Ascended" })).kind).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test tests/metrics-frame.test.ts`
Expected: FAIL — cannot resolve `../src/metrics-frame`.

- [ ] **Step 3: Write the module**

Create `src/metrics-frame.ts`:

```ts
/**
 * The client's diagnostics snapshot, left exactly as it arrived.
 *
 * Deliberately untyped. The plugin walks this to discover what it can offer rather than
 * reading named fields, which is what lets a stat added to the client appear in the dropdown
 * without a plugin release. Typing it here would turn every client change into a plugin change.
 */
export type Snapshot = Record<string, unknown>;

/**
 * Why the snapshot stream is silent, or that it is not.
 *
 * The client's `ConnectionHealth` carries versions and a refusal reason on two of its variants.
 * Neither fits on a key, so neither is kept: a controller draws the status word and nothing
 * else.
 */
export type HealthState =
  | { status: "Connected" }
  | { status: "Reconnecting"; attempt: number }
  | { status: "Disconnected" }
  | { status: "Failed" }
  | { status: "VersionMismatch" }
  | { status: "Unauthorized" };

export type MetricsFrame =
  | { kind: "metrics"; snapshot: Snapshot }
  | { kind: "health"; health: HealthState }
  | { kind: "unknown" };

const UNKNOWN: MetricsFrame = { kind: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toHealth(data: Record<string, unknown>): HealthState | null {
  switch (data.status) {
    case "Connected":
      return { status: "Connected" };
    case "Reconnecting":
      return {
        status: "Reconnecting",
        attempt: typeof data.attempt === "number" ? data.attempt : 0,
      };
    case "Disconnected":
      return { status: "Disconnected" };
    case "Failed":
      return { status: "Failed" };
    case "VersionMismatch":
      return { status: "VersionMismatch" };
    case "Unauthorized":
      return { status: "Unauthorized" };
    default:
      return null;
  }
}

/**
 * Turn one raw `/metrics` message into a frame.
 *
 * This route tags every frame with `type`, so there is no shape guessing here — unlike the
 * command socket, whose responses are an untagged Rust enum.
 */
export function parseMetricsFrame(raw: string): MetricsFrame {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return UNKNOWN;
  }

  if (!isRecord(message)) return UNKNOWN;

  const data = message.data;
  if (!isRecord(data)) return UNKNOWN;

  if (message.type === "metrics") return { kind: "metrics", snapshot: data };

  if (message.type === "health") {
    const health = toHealth(data);
    return health === null ? UNKNOWN : { kind: "health", health };
  }

  return UNKNOWN;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test tests/metrics-frame.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/metrics-frame.ts tests/metrics-frame.test.ts
git commit -m "feat: parse metrics and health frames"
```

---

### Task 5: The metrics subscription core

The decisions the metrics subscription makes, with no socket and no timers: how many keys want
it open, how old the last snapshot is, and what a frame changes.

This split follows the precedent already in the repo — `pending-requests.ts` holds the
correlation logic that `ws-manager.ts` drives. Reference counting and staleness are the parts
that can be wrong, and neither needs a WebSocket to exercise.

**Deviation from the spec.** The spec asks for `tests/metrics-manager.test.ts`, run "against a
fake socket". This plan tests `metrics-core` instead. The spec's four cases are all covered
here — first acquire opens, two acquires need two releases, the watchdog reports a staleness
crossing — but they are exercised directly rather than through a fake socket. A settings change
reopening the socket is the one case that moves into the untested shell, and it is three lines
that mirror `ws-manager.ts`'s existing handler. The alternative, a socket port with a fake
implementation, buys coverage of wiring the SDK already owns at the cost of a harness larger
than the code it tests.

**Files:**
- Create: `src/metrics-core.ts`
- Test: `tests/metrics-core.test.ts`

**Interfaces:**
- Consumes: `HealthState`, `MetricsFrame`, `Snapshot` from `src/metrics-frame.ts`.
- Produces:
  - `STALE_AFTER_MS = 3000`
  - `type MetricsEvent = "snapshot" | "health" | "socket" | "stale"`
  - `class MetricsCore` with `acquire(): "open" | "none"`, `release(): "close" | "none"`,
    `setSocketUp(up: boolean): MetricsEvent[]`,
    `applyFrame(frame: MetricsFrame, nowMs: number): MetricsEvent[]`,
    `tick(nowMs: number): MetricsEvent[]`, `ageMs(nowMs: number): number | null`,
    `isStale(nowMs: number): boolean`, and the getters `subscribed`, `socketUp`, `snapshot`,
    `health`

- [ ] **Step 1: Write the failing test**

Create `tests/metrics-core.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { MetricsCore, STALE_AFTER_MS } from "../src/metrics-core";
import type { MetricsFrame } from "../src/metrics-frame";

const snapshotFrame = (rtt: number): MetricsFrame => ({
  kind: "metrics",
  snapshot: { link: { rtt_ms: rtt } },
});

const healthFrame: MetricsFrame = { kind: "health", health: { status: "Connected" } };

describe("MetricsCore reference counting", () => {
  test("the first key asks for the socket to open", () => {
    const core = new MetricsCore();
    expect(core.acquire()).toBe("open");
    expect(core.subscribed).toBe(true);
  });

  test("a second key does not open a second socket", () => {
    const core = new MetricsCore();
    core.acquire();
    expect(core.acquire()).toBe("none");
  });

  test("the last key to go asks for the socket to close", () => {
    const core = new MetricsCore();
    core.acquire();
    expect(core.release()).toBe("close");
    expect(core.subscribed).toBe(false);
  });

  test("two keys need two releases", () => {
    const core = new MetricsCore();
    core.acquire();
    core.acquire();
    expect(core.release()).toBe("none");
    expect(core.release()).toBe("close");
  });

  test("a release with nothing behind it does nothing and does not go negative", () => {
    const core = new MetricsCore();
    expect(core.release()).toBe("none");
    expect(core.acquire()).toBe("open");
  });
});

describe("MetricsCore frames", () => {
  test("a metrics frame is kept and reported", () => {
    const core = new MetricsCore();
    const events = core.applyFrame(snapshotFrame(42), 1000);
    expect(events).toContain("snapshot");
    expect(core.snapshot).toEqual({ link: { rtt_ms: 42 } });
  });

  test("the first metrics frame also reports the end of staleness", () => {
    const core = new MetricsCore();
    expect(core.applyFrame(snapshotFrame(42), 1000)).toEqual(["snapshot", "stale"]);
  });

  test("a second metrics frame reports only the snapshot", () => {
    const core = new MetricsCore();
    core.applyFrame(snapshotFrame(42), 1000);
    expect(core.applyFrame(snapshotFrame(43), 2000)).toEqual(["snapshot"]);
  });

  test("a health frame is kept and reported", () => {
    const core = new MetricsCore();
    expect(core.applyFrame(healthFrame, 1000)).toEqual(["health"]);
    expect(core.health).toEqual({ status: "Connected" });
  });

  test("an unknown frame changes nothing", () => {
    const core = new MetricsCore();
    expect(core.applyFrame({ kind: "unknown" }, 1000)).toEqual([]);
    expect(core.snapshot).toBeNull();
  });
});

describe("MetricsCore staleness", () => {
  test("nothing received is stale", () => {
    const core = new MetricsCore();
    expect(core.isStale(1000)).toBe(true);
    expect(core.ageMs(1000)).toBeNull();
  });

  test("a fresh snapshot is not stale", () => {
    const core = new MetricsCore();
    core.applyFrame(snapshotFrame(42), 1000);
    expect(core.isStale(1500)).toBe(false);
    expect(core.ageMs(1500)).toBe(500);
  });

  test("a snapshot older than the threshold is stale", () => {
    const core = new MetricsCore();
    core.applyFrame(snapshotFrame(42), 1000);
    expect(core.isStale(1000 + STALE_AFTER_MS)).toBe(true);
  });

  test("the watchdog reports the crossing into staleness once", () => {
    const core = new MetricsCore();
    core.applyFrame(snapshotFrame(42), 1000);

    expect(core.tick(2000)).toEqual([]);
    expect(core.tick(1000 + STALE_AFTER_MS)).toEqual(["stale"]);
    expect(core.tick(1000 + STALE_AFTER_MS + 1000)).toEqual([]);
  });

  test("the watchdog says nothing while nothing has ever arrived", () => {
    const core = new MetricsCore();
    expect(core.tick(1000)).toEqual([]);
    expect(core.tick(9000)).toEqual([]);
  });
});

describe("MetricsCore socket state", () => {
  test("the socket coming up is reported once", () => {
    const core = new MetricsCore();
    expect(core.setSocketUp(true)).toEqual(["socket"]);
    expect(core.setSocketUp(true)).toEqual([]);
    expect(core.socketUp).toBe(true);
  });

  test("the socket going down discards everything it reported", () => {
    const core = new MetricsCore();
    core.setSocketUp(true);
    core.applyFrame(snapshotFrame(42), 1000);
    core.applyFrame(healthFrame, 1000);

    expect(core.setSocketUp(false)).toEqual(["socket"]);
    expect(core.snapshot).toBeNull();
    expect(core.health).toBeNull();
    expect(core.ageMs(2000)).toBeNull();
  });

  test("a snapshot after a reconnect reports the end of staleness again", () => {
    const core = new MetricsCore();
    core.setSocketUp(true);
    core.applyFrame(snapshotFrame(42), 1000);
    core.setSocketUp(false);
    core.setSocketUp(true);

    expect(core.applyFrame(snapshotFrame(43), 5000)).toEqual(["snapshot", "stale"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test tests/metrics-core.test.ts`
Expected: FAIL — cannot resolve `../src/metrics-core`.

- [ ] **Step 3: Write the module**

Create `src/metrics-core.ts`:

```ts
import type { HealthState, MetricsFrame, Snapshot } from "./metrics-frame";

/**
 * How long a snapshot may go unrefreshed before its numbers stop being drawn.
 *
 * Three missed pushes at the client's 1 Hz cadence. Holding the last number past that would
 * draw a dead link as a healthy one, which is the failure this stream exists to report.
 */
export const STALE_AFTER_MS = 3000;

export type MetricsEvent = "snapshot" | "health" | "socket" | "stale";

/**
 * The decisions the metrics subscription makes, with no socket and no timers.
 *
 * Split from the transport for the reason `pending-requests.ts` is split from `ws-manager.ts`:
 * reference counting, staleness and frame application are the parts that can be wrong, and
 * none of them need a WebSocket to exercise.
 */
export class MetricsCore {
  private refs = 0;
  private open = false;
  private lastSnapshot: Snapshot | null = null;
  private lastFrameAtMs: number | null = null;
  private lastHealth: HealthState | null = null;

  // Starts true: nothing has arrived, so nothing is fresh. Without this the first snapshot
  // would report no change and a key waiting on the event would never draw.
  private staleReported = true;

  get subscribed(): boolean {
    return this.refs > 0;
  }

  get socketUp(): boolean {
    return this.open;
  }

  get snapshot(): Snapshot | null {
    return this.lastSnapshot;
  }

  get health(): HealthState | null {
    return this.lastHealth;
  }

  ageMs(nowMs: number): number | null {
    return this.lastFrameAtMs === null ? null : nowMs - this.lastFrameAtMs;
  }

  isStale(nowMs: number): boolean {
    const age = this.ageMs(nowMs);
    return age === null || age >= STALE_AFTER_MS;
  }

  /** A stat key appeared. "open" only on the first, so the socket is opened once. */
  acquire(): "open" | "none" {
    this.refs += 1;
    return this.refs === 1 ? "open" : "none";
  }

  /** A stat key went away. "close" only on the last. A release with nothing behind it is a no-op. */
  release(): "close" | "none" {
    if (this.refs === 0) return "none";
    this.refs -= 1;
    return this.refs === 0 ? "close" : "none";
  }

  /**
   * The socket came up or went down.
   *
   * Nothing measured survives the socket going down. A number kept from before the drop would
   * be drawn as current the moment the socket came back, before any frame had arrived.
   */
  setSocketUp(up: boolean): MetricsEvent[] {
    if (this.open === up) return [];
    this.open = up;

    if (!up) {
      this.lastSnapshot = null;
      this.lastFrameAtMs = null;
      this.lastHealth = null;
      this.staleReported = true;
    }

    return ["socket"];
  }

  applyFrame(frame: MetricsFrame, nowMs: number): MetricsEvent[] {
    switch (frame.kind) {
      case "metrics": {
        this.lastSnapshot = frame.snapshot;
        this.lastFrameAtMs = nowMs;

        const events: MetricsEvent[] = ["snapshot"];
        if (this.staleReported) {
          this.staleReported = false;
          events.push("stale");
        }
        return events;
      }

      case "health":
        this.lastHealth = frame.health;
        return ["health"];

      case "unknown":
        return [];
    }
  }

  /**
   * The watchdog.
   *
   * Non-empty only when staleness changes, so a quiet second costs no redraw. Without this a
   * key that stopped receiving frames would keep drawing its last numbers forever: there is no
   * frame to trigger the redraw that would clear them.
   */
  tick(nowMs: number): MetricsEvent[] {
    const stale = this.isStale(nowMs);
    if (stale === this.staleReported) return [];
    this.staleReported = stale;
    return ["stale"];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test tests/metrics-core.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/metrics-core.ts tests/metrics-core.test.ts
git commit -m "feat: add the metrics subscription core"
```

---

### Task 6: Stat path discovery

Turn a snapshot into the list of things a user can pick, and read one back by path.

Arrays are skipped. `peers` and `history` need a presentation a single number on a key does not
have, and are out of scope. Two paths are hidden: `captured_at_ms` is bookkeeping the staleness
check uses, and `meter_events_per_sec` measures the client's own webview paint rate, which
means nothing on a controller.

**Files:**
- Create: `src/stat-paths.ts`
- Test: `tests/stat-paths.test.ts`

**Interfaces:**
- Consumes: `Snapshot` from `src/metrics-frame.ts`.
- Produces:
  - `type StatValue = number | string | boolean | null`
  - `interface StatEntry { path: string; value: StatValue }`
  - `flattenSnapshot(snapshot: Snapshot | null): StatEntry[]`
  - `readPath(snapshot: Snapshot | null, path: string): StatValue`

- [ ] **Step 1: Write the failing test**

Create `tests/stat-paths.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { flattenSnapshot, readPath } from "../src/stat-paths";

const SNAPSHOT = {
  captured_at_ms: 1_700_000_000_000,
  mic: { device: "Yeti", sample_rate: 48000, capture_frames_per_sec: null },
  link: { rtt_ms: 42, stalled: false },
  meter_events_per_sec: 30,
  peers: [{ name: "someone", underruns: 3 }],
  history: [{ rtt_ms: 40 }],
};

describe("flattenSnapshot", () => {
  test("finds the nested scalars", () => {
    expect(flattenSnapshot(SNAPSHOT)).toEqual([
      { path: "mic.device", value: "Yeti" },
      { path: "mic.sample_rate", value: 48000 },
      { path: "mic.capture_frames_per_sec", value: null },
      { path: "link.rtt_ms", value: 42 },
      { path: "link.stalled", value: false },
    ]);
  });

  test("keeps a stat that is not measured right now, so it stays selectable", () => {
    const paths = flattenSnapshot(SNAPSHOT).map((entry) => entry.path);
    expect(paths).toContain("mic.capture_frames_per_sec");
  });

  test("skips arrays, so per-speaker rows and history are not offered", () => {
    const paths = flattenSnapshot(SNAPSHOT).map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith("peers"))).toBe(false);
    expect(paths.some((path) => path.startsWith("history"))).toBe(false);
  });

  test("hides the two paths that are not stats", () => {
    const paths = flattenSnapshot(SNAPSHOT).map((entry) => entry.path);
    expect(paths).not.toContain("captured_at_ms");
    expect(paths).not.toContain("meter_events_per_sec");
  });

  test("a missing snapshot has nothing to offer", () => {
    expect(flattenSnapshot(null)).toEqual([]);
  });

  test("an empty snapshot has nothing to offer", () => {
    expect(flattenSnapshot({})).toEqual([]);
  });
});

describe("readPath", () => {
  test("reads a nested value", () => {
    expect(readPath(SNAPSHOT, "link.rtt_ms")).toBe(42);
  });

  test("reads a boolean", () => {
    expect(readPath(SNAPSHOT, "link.stalled")).toBe(false);
  });

  test("reads a string", () => {
    expect(readPath(SNAPSHOT, "mic.device")).toBe("Yeti");
  });

  test("a path that is not there reads as not measured", () => {
    expect(readPath(SNAPSHOT, "link.nonsense")).toBeNull();
    expect(readPath(SNAPSHOT, "nonsense.at.all")).toBeNull();
  });

  test("a path naming an object rather than a value reads as not measured", () => {
    expect(readPath(SNAPSHOT, "link")).toBeNull();
  });

  test("a path naming an array reads as not measured", () => {
    expect(readPath(SNAPSHOT, "peers")).toBeNull();
  });

  test("a missing snapshot reads as not measured", () => {
    expect(readPath(null, "link.rtt_ms")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test tests/stat-paths.test.ts`
Expected: FAIL — cannot resolve `../src/stat-paths`.

- [ ] **Step 3: Write the module**

Create `src/stat-paths.ts`:

```ts
import type { Snapshot } from "./metrics-frame";

/** A leaf of the snapshot. `null` means the client is not measuring it right now. */
export type StatValue = number | string | boolean | null;

export interface StatEntry {
  path: string;
  value: StatValue;
}

/**
 * Paths that are in the snapshot but are not stats.
 *
 * `captured_at_ms` is the timestamp the staleness check reads. `meter_events_per_sec` counts
 * the client's own webview paints, which describes its renderer and nothing a controller can
 * act on.
 */
const HIDDEN_PATHS: ReadonlySet<string> = new Set(["captured_at_ms", "meter_events_per_sec"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A scalar, or `undefined` when the value is not a leaf at all. */
function toStatValue(value: unknown): StatValue | undefined {
  if (value === null) return null;
  const type = typeof value;
  if (type === "number" || type === "string" || type === "boolean") {
    return value as StatValue;
  }
  return undefined;
}

function walk(node: Record<string, unknown>, prefix: string, entries: StatEntry[]): void {
  for (const [key, raw] of Object.entries(node)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (HIDDEN_PATHS.has(path)) continue;

    // Arrays are out of scope. A per-speaker row and an RTT history are lists, and a key holds
    // one number.
    if (Array.isArray(raw)) continue;

    if (isRecord(raw)) {
      walk(raw, path, entries);
      continue;
    }

    const value = toStatValue(raw);
    if (value === undefined) continue;
    entries.push({ path, value });
  }
}

/**
 * Everything in this snapshot a key could show, in the order the client reported it.
 *
 * The order is the Rust struct's field order, preserved through JSON, which is why the
 * dropdown reads in a sensible order without the plugin knowing any of the names.
 */
export function flattenSnapshot(snapshot: Snapshot | null): StatEntry[] {
  if (snapshot === null) return [];
  const entries: StatEntry[] = [];
  walk(snapshot, "", entries);
  return entries;
}

/** Read one path. Anything missing, or anything that is not a scalar, is not measured. */
export function readPath(snapshot: Snapshot | null, path: string): StatValue {
  if (snapshot === null) return null;

  let node: unknown = snapshot;
  for (const segment of path.split(".")) {
    if (!isRecord(node)) return null;
    node = node[segment];
  }

  const value = toStatValue(node);
  return value === undefined ? null : value;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test tests/stat-paths.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stat-paths.ts tests/stat-paths.test.ts
git commit -m "feat: discover selectable stat paths from a snapshot"
```

---

### Task 7: The stat catalog

Labels, units and rounding. A grid cell holds roughly six characters, so labels are terse and
values are rounded hard.

A path with no table entry is still offered: its label comes from its last segment and its
format from the type of the value. That is what keeps the dropdown honest about a client that
has grown a new stat.

**Files:**
- Create: `src/stat-catalog.ts`
- Test: `tests/stat-catalog.test.ts`

**Interfaces:**
- Consumes: `StatValue` from `src/stat-paths.ts`.
- Produces:
  - `type StatSection = "Link" | "Microphone" | "Playback" | "Session" | "Other"`
  - `interface FormattedValue { value: string; unit: string }`
  - `labelFor(path: string): string`
  - `sectionFor(path: string): StatSection`
  - `formatValue(path: string, value: StatValue): FormattedValue`

- [ ] **Step 1: Write the failing test**

Create `tests/stat-catalog.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { formatValue, labelFor, sectionFor } from "../src/stat-catalog";

describe("labelFor", () => {
  test("gives a known path its short label", () => {
    expect(labelFor("link.rtt_ms")).toBe("RTT");
    expect(labelFor("link.worst_concealment_pct")).toBe("CONCEAL");
  });

  test("derives a label for a path it has never seen", () => {
    expect(labelFor("link.new_counter")).toBe("NEW COUNTER");
  });

  test("derives a label for a top-level path", () => {
    expect(labelFor("something")).toBe("SOMETHING");
  });
});

describe("sectionFor", () => {
  test("groups by the first path segment", () => {
    expect(sectionFor("link.rtt_ms")).toBe("Link");
    expect(sectionFor("mic.muted")).toBe("Microphone");
    expect(sectionFor("playback.deafened")).toBe("Playback");
    expect(sectionFor("session.server")).toBe("Session");
  });

  test("an unrecognised group is Other", () => {
    expect(sectionFor("gpu.temperature")).toBe("Other");
    expect(sectionFor("bare")).toBe("Other");
  });
});

describe("formatValue", () => {
  test("draws a value that is not measured as a dash", () => {
    expect(formatValue("link.rtt_ms", null)).toEqual({ value: "—", unit: "" });
  });

  test("rounds a round-trip time to whole milliseconds", () => {
    expect(formatValue("link.rtt_ms", 42.7)).toEqual({ value: "43", unit: "ms" });
  });

  test("rounds a percentage to one decimal", () => {
    expect(formatValue("link.uplink_loss_pct", 0.4231)).toEqual({ value: "0.4", unit: "%" });
  });

  test("shortens a large count so it fits a cell", () => {
    expect(formatValue("link.datagrams_dropped", 12345).value).toBe("12.3k");
    expect(formatValue("link.datagrams_dropped", 2_400_000).value).toBe("2.4M");
  });

  test("does not shorten a port, which is an identifier and not a quantity", () => {
    expect(formatValue("link.quic_port", 19132)).toEqual({ value: "19132", unit: "" });
  });

  test("scales a sample rate reported in hertz", () => {
    expect(formatValue("mic.sample_rate", 48000)).toEqual({ value: "48.0", unit: "kHz" });
  });

  test("draws an uptime under a minute in seconds", () => {
    expect(formatValue("link.uptime_secs", 45)).toEqual({ value: "45s", unit: "" });
  });

  test("draws an uptime under an hour in minutes", () => {
    expect(formatValue("link.uptime_secs", 720)).toEqual({ value: "12m", unit: "" });
  });

  test("draws a longer uptime in hours and minutes", () => {
    expect(formatValue("link.uptime_secs", 3720)).toEqual({ value: "1h02", unit: "" });
  });

  test("draws a boolean with the words its stat calls for", () => {
    expect(formatValue("link.stalled", true).value).toBe("YES");
    expect(formatValue("link.stalled", false).value).toBe("NO");
    expect(formatValue("mic.muted", true).value).toBe("OFF");
    expect(formatValue("mic.muted", false).value).toBe("ON");
  });

  test("shortens the transport names, which do not fit as reported", () => {
    expect(formatValue("session.transport", "WebSocket").value).toBe("WSS");
    expect(formatValue("session.transport", "Quic").value).toBe("QUIC");
  });

  test("passes an unmapped transport through rather than hiding it", () => {
    expect(formatValue("session.transport", "Carrier Pigeon").value).toBe("CARRIER PIGEON");
  });

  test("upper-cases a text stat", () => {
    expect(formatValue("mic.device", "Blue Yeti")).toEqual({ value: "BLUE YETI", unit: "" });
  });

  test("formats an unknown numeric path to one decimal", () => {
    expect(formatValue("link.new_counter", 3.14159)).toEqual({ value: "3.1", unit: "" });
  });

  test("formats an unknown boolean path as yes or no", () => {
    expect(formatValue("link.new_flag", true).value).toBe("YES");
  });

  test("formats an unknown text path as text", () => {
    expect(formatValue("link.new_name", "hello").value).toBe("HELLO");
  });

  test("a value of the wrong type for its stat is not measured", () => {
    expect(formatValue("link.rtt_ms", "forty two")).toEqual({ value: "—", unit: "" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test tests/stat-catalog.test.ts`
Expected: FAIL — cannot resolve `../src/stat-catalog`.

- [ ] **Step 3: Write the module**

Create `src/stat-catalog.ts`:

```ts
import type { StatValue } from "./stat-paths";

export type StatSection = "Link" | "Microphone" | "Playback" | "Session" | "Other";

type ValueFormat =
  | { kind: "number"; decimals: number; unit: string; scale?: number; plain?: boolean }
  | { kind: "duration" }
  | { kind: "boolean"; whenTrue: string; whenFalse: string }
  | { kind: "map"; values: Readonly<Record<string, string>> }
  | { kind: "text" };

interface StatDefinition {
  label: string;
  format: ValueFormat;
}

export interface FormattedValue {
  value: string;
  unit: string;
}

/** Below this a count is drawn as it is; above it, shortened, because a cell is six characters. */
const SHORTEN_ABOVE = 10_000;
const MILLION = 1_000_000;

const num = (
  decimals: number,
  unit = "",
  extra: { scale?: number; plain?: boolean } = {},
): ValueFormat => ({ kind: "number", decimals, unit, ...extra });

const bool = (whenTrue: string, whenFalse: string): ValueFormat =>
  ({ kind: "boolean", whenTrue, whenFalse });

const TEXT: ValueFormat = { kind: "text" };
const DURATION: ValueFormat = { kind: "duration" };

/**
 * The stats the client reports today, with a label short enough for a grid cell.
 *
 * Not a gate. A path missing from here is still offered — see `labelFor` and `inferFormat`.
 * This table only makes the known ones read well.
 */
const STAT_CATALOG: Readonly<Record<string, StatDefinition>> = {
  "link.rtt_ms": { label: "RTT", format: num(0, "ms") },
  "link.rtt_variance_ms": { label: "JITTER", format: num(0, "ms") },
  "link.uplink_loss_pct": { label: "UP LOSS", format: num(1, "%") },
  "link.downlink_loss_pct": { label: "DN LOSS", format: num(1, "%") },
  "link.burst_loss_pct": { label: "BURST", format: num(1, "%") },
  "link.worst_concealment_pct": { label: "CONCEAL", format: num(1, "%") },
  "link.jitter_buffer_ms": { label: "BUFFER", format: num(0, "ms") },
  "link.jitter_buffer_drops": { label: "DROPS", format: num(0) },
  "link.datagrams_dropped": { label: "LOST", format: num(0) },
  "link.uptime_secs": { label: "UPTIME", format: DURATION },
  "link.paths_used": { label: "PATHS", format: num(0) },
  "link.quic_port": { label: "PORT", format: num(0, "", { plain: true }) },
  "link.family": { label: "IP", format: TEXT },
  "link.state": { label: "LINK", format: TEXT },
  "link.quality": { label: "QUALITY", format: TEXT },
  "link.stalled": { label: "STALLED", format: bool("YES", "NO") },
  "mic.capture_frames_per_sec": { label: "CAPTURE", format: num(0, "/s") },
  "mic.datagrams_per_sec": { label: "MIC TX", format: num(0, "/s") },
  "mic.noise_gate": { label: "GATE", format: TEXT },
  // A muted microphone is off. Labelling the mute itself would read as "MIC: YES".
  "mic.muted": { label: "MIC", format: bool("OFF", "ON") },
  "mic.sample_rate": { label: "MIC HZ", format: num(1, "kHz", { scale: 0.001 }) },
  "mic.device": { label: "MIC DEV", format: TEXT },
  "playback.datagrams_per_sec": { label: "RX", format: num(0, "/s") },
  "playback.muted_peer_count": { label: "MUTED", format: num(0) },
  "playback.deafened": { label: "DEAF", format: bool("YES", "NO") },
  "playback.sample_rate": { label: "OUT HZ", format: num(1, "kHz", { scale: 0.001 }) },
  "playback.device": { label: "OUT DEV", format: TEXT },
  "session.server": { label: "SERVER", format: TEXT },
  // `TransportKind` has no serde rename, so it arrives as its Rust variant names. "WEBSOCKET"
  // is too wide for a cell, and "WSS" is what the client's own debug pane calls it.
  "session.transport": {
    label: "VIA",
    format: { kind: "map", values: { Quic: "QUIC", WebSocket: "WSS" } },
  },
  "session.protocol_version": { label: "PROTO", format: TEXT },
  "session.proximity_range": { label: "RANGE", format: num(0, "m") },
  "session.falloff": { label: "FALLOFF", format: TEXT },
  "session.family_preference": { label: "IP PREF", format: TEXT },
};

const SECTIONS: Readonly<Record<string, StatSection>> = {
  link: "Link",
  mic: "Microphone",
  playback: "Playback",
  session: "Session",
};

const ABSENT: FormattedValue = { value: "—", unit: "" };

/** The short label for a stat, derived from the path when the catalog has never seen it. */
export function labelFor(path: string): string {
  const known = STAT_CATALOG[path];
  if (known !== undefined) return known.label;

  const last = path.split(".").pop() ?? path;
  return last.replace(/_/g, " ").toUpperCase();
}

/** Which dropdown group a stat belongs to. */
export function sectionFor(path: string): StatSection {
  const group = path.split(".")[0] ?? "";
  return SECTIONS[group] ?? "Other";
}

/** How to draw a value the catalog does not describe, from the value's own type. */
function inferFormat(value: StatValue): ValueFormat {
  if (typeof value === "number") return num(1);
  if (typeof value === "boolean") return bool("YES", "NO");
  return TEXT;
}

function formatNumber(
  value: StatValue,
  format: { decimals: number; unit: string; scale?: number; plain?: boolean },
): FormattedValue {
  if (typeof value !== "number" || !Number.isFinite(value)) return ABSENT;

  const scaled = value * (format.scale ?? 1);

  // A port is an identifier. Shortening it to "19.1k" would make it wrong rather than short.
  if (format.plain === true) return { value: String(scaled), unit: format.unit };

  const magnitude = Math.abs(scaled);
  if (magnitude >= MILLION) {
    return { value: `${(scaled / MILLION).toFixed(1)}M`, unit: format.unit };
  }
  if (magnitude >= SHORTEN_ABOVE) {
    return { value: `${(scaled / 1000).toFixed(1)}k`, unit: format.unit };
  }

  return { value: scaled.toFixed(format.decimals), unit: format.unit };
}

function formatDuration(value: StatValue): FormattedValue {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return ABSENT;

  const total = Math.floor(value);
  if (total < 60) return { value: `${total}s`, unit: "" };
  if (total < 3600) return { value: `${Math.floor(total / 60)}m`, unit: "" };

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return { value: `${hours}h${String(minutes).padStart(2, "0")}`, unit: "" };
}

/**
 * One value, ready to draw.
 *
 * The unit is returned apart from the value because the single-stat layout gives it its own
 * line, while the grid concatenates the two.
 */
export function formatValue(path: string, value: StatValue): FormattedValue {
  if (value === null) return ABSENT;

  const format = STAT_CATALOG[path]?.format ?? inferFormat(value);

  switch (format.kind) {
    case "number":
      return formatNumber(value, format);

    case "duration":
      return formatDuration(value);

    case "boolean":
      return { value: value === true ? format.whenTrue : format.whenFalse, unit: "" };

    case "map": {
      const key = String(value);
      return { value: format.values[key] ?? key.toUpperCase(), unit: "" };
    }

    case "text":
      return { value: String(value).toUpperCase(), unit: "" };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test tests/stat-catalog.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stat-catalog.ts tests/stat-catalog.test.ts
git commit -m "feat: add the stat label and formatting catalog"
```

---

### Task 8: What the stat key draws

The decision logic, in one pure function. Every branch here is a claim made to the user about
whether the numbers on their key mean anything, so all of it is testable without a socket.

The order is most severe first. A socket that is down outranks a health frame saying
`Connected`, because that frame is stale by definition once the socket carrying it has gone.

**Files:**
- Create: `src/stat-view.ts`
- Test: `tests/stat-view.test.ts`

**Interfaces:**
- Consumes: `STALE_AFTER_MS` from `src/metrics-core.ts`, `HealthState` and `Snapshot` from
  `src/metrics-frame.ts`, `readPath` and `StatValue` from `src/stat-paths.ts`, `formatValue`
  and `labelFor` from `src/stat-catalog.ts`.
- Produces:
  - `interface StatCell { label: string; value: string; unit: string }`
  - `type StatTone = "normal" | "alarm"`
  - `type StatView = { kind: "message"; text: string; tone: StatTone } | { kind: "cells"; cells: StatCell[] }`
  - `interface StatViewInput { paths: readonly string[]; snapshot: Snapshot | null; ageMs: number | null; health: HealthState | null; socketUp: boolean }`
  - `configuredPaths(settings: { stat1?: string; stat2?: string; stat3?: string; stat4?: string }): string[]`
  - `statView(input: StatViewInput): StatView`

- [ ] **Step 1: Write the failing test**

Create `tests/stat-view.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { configuredPaths, statView } from "../src/stat-view";
import { STALE_AFTER_MS } from "../src/metrics-core";

const SNAPSHOT = {
  mic: { muted: false },
  link: { rtt_ms: 42, uplink_loss_pct: 0.4 },
};

const live = (paths: string[]) => ({
  paths,
  snapshot: SNAPSHOT,
  ageMs: 500,
  health: { status: "Connected" } as const,
  socketUp: true,
});

describe("configuredPaths", () => {
  test("keeps the configured slots in order", () => {
    expect(configuredPaths({ stat1: "link.rtt_ms", stat2: "mic.muted" }))
      .toEqual(["link.rtt_ms", "mic.muted"]);
  });

  test("closes a gap, so slots 1 and 3 draw as two stats and not three", () => {
    expect(configuredPaths({ stat1: "link.rtt_ms", stat3: "mic.muted" }))
      .toEqual(["link.rtt_ms", "mic.muted"]);
  });

  test("treats an empty slot as unset", () => {
    expect(configuredPaths({ stat1: "", stat2: "mic.muted" })).toEqual(["mic.muted"]);
  });

  test("nothing configured is no paths", () => {
    expect(configuredPaths({})).toEqual([]);
  });
});

describe("statView", () => {
  test("says so when no stat has been chosen", () => {
    expect(statView({ ...live([]), paths: [] }))
      .toEqual({ kind: "message", text: "NO STATS", tone: "normal" });
  });

  test("a shut socket outranks a health frame that says connected", () => {
    const view = statView({ ...live(["link.rtt_ms"]), socketUp: false });
    expect(view).toEqual({ kind: "message", text: "NO CLIENT", tone: "alarm" });
  });

  test("draws a refused identity as an alarm", () => {
    const view = statView({ ...live(["link.rtt_ms"]), health: { status: "Unauthorized" } });
    expect(view).toEqual({ kind: "message", text: "AUTH", tone: "alarm" });
  });

  test("draws a version mismatch as an alarm", () => {
    const view = statView({ ...live(["link.rtt_ms"]), health: { status: "VersionMismatch" } });
    expect(view).toEqual({ kind: "message", text: "VERSION", tone: "alarm" });
  });

  test("draws a failure as an alarm", () => {
    const view = statView({ ...live(["link.rtt_ms"]), health: { status: "Failed" } });
    expect(view).toEqual({ kind: "message", text: "FAILED", tone: "alarm" });
  });

  test("draws a disconnected client plainly, because it is not an emergency", () => {
    const view = statView({ ...live(["link.rtt_ms"]), health: { status: "Disconnected" } });
    expect(view).toEqual({ kind: "message", text: "OFFLINE", tone: "normal" });
  });

  test("draws a reconnecting client with its attempt, plainly", () => {
    const view = statView({
      ...live(["link.rtt_ms"]),
      health: { status: "Reconnecting", attempt: 3 },
    });
    expect(view).toEqual({ kind: "message", text: "RETRY 3", tone: "normal" });
  });

  test("draws the values when everything is live", () => {
    expect(statView(live(["link.rtt_ms"]))).toEqual({
      kind: "cells",
      cells: [{ label: "RTT", value: "42", unit: "ms" }],
    });
  });

  test("draws four values in the configured order", () => {
    const view = statView(live(["link.rtt_ms", "link.uplink_loss_pct", "mic.muted", "link.rtt_ms"]));
    expect(view.kind === "cells" && view.cells.map((cell) => cell.label))
      .toEqual(["RTT", "UP LOSS", "MIC", "RTT"]);
  });

  test("draws dashes rather than the last numbers once a snapshot goes stale", () => {
    const view = statView({ ...live(["link.rtt_ms"]), ageMs: STALE_AFTER_MS });
    expect(view).toEqual({
      kind: "cells",
      cells: [{ label: "RTT", value: "—", unit: "" }],
    });
  });

  test("draws dashes when no snapshot has arrived at all", () => {
    const view = statView({ ...live(["link.rtt_ms"]), snapshot: null, ageMs: null });
    expect(view.kind === "cells" && view.cells[0]?.value).toBe("—");
  });

  test("draws the values when no health frame has arrived yet", () => {
    const view = statView({ ...live(["link.rtt_ms"]), health: null });
    expect(view.kind === "cells" && view.cells[0]?.value).toBe("42");
  });

  test("a stat the snapshot does not carry draws as a dash beside the ones it does", () => {
    const view = statView(live(["link.rtt_ms", "link.gone"]));
    expect(view.kind === "cells" && view.cells.map((cell) => cell.value)).toEqual(["42", "—"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test tests/stat-view.test.ts`
Expected: FAIL — cannot resolve `../src/stat-view`.

- [ ] **Step 3: Write the module**

Create `src/stat-view.ts`:

```ts
import { STALE_AFTER_MS } from "./metrics-core";
import type { HealthState, Snapshot } from "./metrics-frame";
import { formatValue, labelFor } from "./stat-catalog";
import { readPath } from "./stat-paths";

export interface StatCell {
  label: string;
  value: string;
  unit: string;
}

export type StatTone = "normal" | "alarm";

export type StatView =
  | { kind: "message"; text: string; tone: StatTone }
  | { kind: "cells"; cells: StatCell[] };

export interface StatViewInput {
  /** The configured slots, gaps already closed. */
  paths: readonly string[];
  snapshot: Snapshot | null;
  /** Milliseconds since the last snapshot, or `null` if none has arrived. */
  ageMs: number | null;
  health: HealthState | null;
  /** The plugin's own `/metrics` socket. */
  socketUp: boolean;
}

/** The paths a key is configured with, in slot order, with the empty slots closed up. */
export function configuredPaths(settings: {
  stat1?: string;
  stat2?: string;
  stat3?: string;
  stat4?: string;
}): string[] {
  return [settings.stat1, settings.stat2, settings.stat3, settings.stat4].filter(
    (path): path is string => typeof path === "string" && path !== "",
  );
}

function message(text: string, tone: StatTone = "normal"): StatView {
  return { kind: "message", text, tone };
}

/**
 * The word for a client that is not carrying a session, or `null` when it is.
 *
 * Only a refusal is an alarm. A disconnect and a reconnect are ordinary states of a client
 * working on it, and colouring those as alarms would cry wolf on every reconnect.
 */
function healthMessage(health: HealthState): StatView | null {
  switch (health.status) {
    case "Unauthorized":
      return message("AUTH", "alarm");
    case "VersionMismatch":
      return message("VERSION", "alarm");
    case "Failed":
      return message("FAILED", "alarm");
    case "Disconnected":
      return message("OFFLINE");
    case "Reconnecting":
      return message(`RETRY ${health.attempt}`);
    case "Connected":
      return null;
  }
}

function cell(path: string, snapshot: Snapshot | null): StatCell {
  const formatted = formatValue(path, readPath(snapshot, path));
  return { label: labelFor(path), value: formatted.value, unit: formatted.unit };
}

/**
 * What this key should draw right now.
 *
 * Most severe first. A shut socket outranks a health frame that says `Connected`, because that
 * frame stopped being current the moment the socket carrying it went away.
 */
export function statView(input: StatViewInput): StatView {
  if (input.paths.length === 0) return message("NO STATS");
  if (!input.socketUp) return message("NO CLIENT", "alarm");

  if (input.health !== null) {
    const drawn = healthMessage(input.health);
    if (drawn !== null) return drawn;
  }

  // A stale snapshot is discarded rather than redrawn. Its numbers describe a moment that has
  // passed, and on a key there is nothing to say so except not showing them.
  const stale = input.ageMs === null || input.ageMs >= STALE_AFTER_MS;
  const snapshot = stale ? null : input.snapshot;

  return { kind: "cells", cells: input.paths.map((path) => cell(path, snapshot)) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test tests/stat-view.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stat-view.ts tests/stat-view.test.ts
git commit -m "feat: decide what a stat key draws"
```

---

### Task 9: The stat key image

Turn a view into an SVG data URI. A pure function: the same view always produces the same
string, which is what the action's no-redraw check depends on.

Values can contain a device name the user chose, so every piece of text is XML-escaped. An
ampersand in "Focusrite & Co" would otherwise produce an SVG the Stream Deck cannot parse, and
the key would go blank.

**Files:**
- Create: `src/stat-image.ts`
- Test: `tests/stat-image.test.ts`

**Interfaces:**
- Consumes: `StatCell`, `StatView` from `src/stat-view.ts`.
- Produces: `renderStatKey(view: StatView): string` — a `data:image/svg+xml;base64,…` URI.

- [ ] **Step 1: Write the failing test**

Create `tests/stat-image.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { renderStatKey } from "../src/stat-image";
import type { StatCell, StatView } from "../src/stat-view";

const PREFIX = "data:image/svg+xml;base64,";

const decode = (uri: string): string =>
  Buffer.from(uri.slice(PREFIX.length), "base64").toString("utf8");

const cells = (count: number): StatCell[] =>
  Array.from({ length: count }, (_, index) => ({
    label: `L${index}`,
    value: `${index}`,
    unit: "ms",
  }));

const view = (count: number): StatView => ({ kind: "cells", cells: cells(count) });

describe("renderStatKey", () => {
  test("returns a base64 SVG data URI", () => {
    expect(renderStatKey(view(1)).startsWith(PREFIX)).toBe(true);
  });

  test("draws a 144 square on the plugin's background", () => {
    const svg = decode(renderStatKey(view(1)));
    expect(svg).toContain('viewBox="0 0 144 144"');
    expect(svg).toContain('fill="#19102f"');
  });

  test("gives one stat the whole key, with its unit on its own line", () => {
    const svg = decode(renderStatKey({
      kind: "cells",
      cells: [{ label: "RTT", value: "42", unit: "ms" }],
    }));
    expect(svg).toContain(">RTT<");
    expect(svg).toContain(">42<");
    expect(svg).toContain(">ms<");
    expect(svg).toContain('font-size="46"');
  });

  test("omits the unit line for a stat that has no unit", () => {
    const svg = decode(renderStatKey({
      kind: "cells",
      cells: [{ label: "LINK", value: "UP", unit: "" }],
    }));
    expect(svg.match(/<text/g)).toHaveLength(2);
  });

  test("stacks two stats as label left and value right", () => {
    const svg = decode(renderStatKey(view(2)));
    expect(svg.match(/text-anchor="start"/g)).toHaveLength(2);
    expect(svg.match(/text-anchor="end"/g)).toHaveLength(2);
  });

  test("joins the unit to the value in a stacked row", () => {
    const svg = decode(renderStatKey(view(2)));
    expect(svg).toContain(">0ms<");
  });

  test("draws three stats in the grid, leaving the fourth cell empty", () => {
    const svg = decode(renderStatKey(view(3)));
    expect(svg.match(/<text/g)).toHaveLength(6);
  });

  test("draws four stats as eight pieces of text", () => {
    const svg = decode(renderStatKey(view(4)));
    expect(svg.match(/<text/g)).toHaveLength(8);
  });

  test("draws a message centred", () => {
    const svg = decode(renderStatKey({ kind: "message", text: "OFFLINE", tone: "normal" }));
    expect(svg).toContain(">OFFLINE<");
    expect(svg).toContain('text-anchor="middle"');
  });

  test("draws an alarm message in the alarm colour", () => {
    const svg = decode(renderStatKey({ kind: "message", text: "AUTH", tone: "alarm" }));
    expect(svg).toContain('fill="#ff8266"');
  });

  test("shrinks a long message so it fits the key", () => {
    const short = decode(renderStatKey({ kind: "message", text: "AUTH", tone: "alarm" }));
    const long = decode(renderStatKey({ kind: "message", text: "NO CLIENT", tone: "alarm" }));
    expect(short).toContain('font-size="24"');
    expect(long).toContain('font-size="18"');
  });

  test("escapes text, so a device name cannot break the image", () => {
    const svg = decode(renderStatKey({
      kind: "cells",
      cells: [{ label: "MIC DEV", value: "FOCUSRITE & <CO>", unit: "" }],
    }));
    expect(svg).toContain("FOCUSRITE &amp; &lt;CO&gt;");
    expect(svg).not.toContain("<CO>");
  });

  test("the same view always produces the same string", () => {
    expect(renderStatKey(view(4))).toBe(renderStatKey(view(4)));
  });

  test("a different value produces a different string", () => {
    const a = renderStatKey({ kind: "cells", cells: [{ label: "RTT", value: "42", unit: "ms" }] });
    const b = renderStatKey({ kind: "cells", cells: [{ label: "RTT", value: "43", unit: "ms" }] });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test tests/stat-image.test.ts`
Expected: FAIL — cannot resolve `../src/stat-image`.

- [ ] **Step 3: Write the module**

Create `src/stat-image.ts`:

```ts
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

const TWO_ROW_Y = [50, 108];
const GRID_X = [40, 104];
const GRID_LABEL_Y = [46, 106];
const GRID_VALUE_Y = [70, 130];

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

/** One stat gets the whole key: a label, a large value, and the unit on its own line. */
function oneCell(cell: StatCell): string {
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
      x: 72, y: 92, size: 46, colour: VALUE_COLOUR, anchor: "middle",
      bold: true, content: cell.value,
    }) +
    unit
  );
}

/** Two stats stack as full-width rows, label left and value right. */
function twoCells(cells: readonly StatCell[]): string {
  return cells
    .map((cell, index) => {
      const y = TWO_ROW_Y[index] ?? TWO_ROW_Y[0]!;
      return (
        text({
          x: 12, y, size: 18, colour: LABEL_COLOUR, anchor: "start",
          opacity: LABEL_OPACITY, content: cell.label,
        }) +
        text({
          x: 132, y, size: 24, colour: VALUE_COLOUR, anchor: "end",
          bold: true, content: cell.value + cell.unit,
        })
      );
    })
    .join("");
}

/** Three or four stats share a 2x2 grid. Three leaves the last cell empty. */
function gridCells(cells: readonly StatCell[]): string {
  return cells
    .map((cell, index) => {
      const x = GRID_X[index % 2]!;
      const row = index < 2 ? 0 : 1;
      return (
        text({
          x, y: GRID_LABEL_Y[row]!, size: 14, colour: LABEL_COLOUR, anchor: "middle",
          opacity: LABEL_OPACITY, content: cell.label,
        }) +
        text({
          x, y: GRID_VALUE_Y[row]!, size: 21, colour: VALUE_COLOUR, anchor: "middle",
          bold: true, content: cell.value + cell.unit,
        })
      );
    })
    .join("");
}

function cellBody(cells: readonly StatCell[]): string {
  if (cells.length === 1) return oneCell(cells[0]!);
  if (cells.length === 2) return twoCells(cells);
  return gridCells(cells);
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
    : cellBody(view.cells);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"` +
    ` viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${BACKGROUND}"/>` +
    `${body}</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test tests/stat-image.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/stat-image.ts tests/stat-image.test.ts
git commit -m "feat: draw the stat key image"
```

---

### Task 10: The metrics socket

The transport shell. It owns the `ws` socket, the backoff, the watchdog timer and the listener
set, and hands every decision to `MetricsCore`. This mirrors `ws-manager.ts` and, like it, is
not unit tested — everything worth testing was moved out in Task 5.

**Files:**
- Create: `src/metrics-manager.ts`

**Interfaces:**
- Consumes: `MetricsCore`, `MetricsEvent` from `src/metrics-core.ts`; `parseMetricsFrame`,
  `HealthState`, `Snapshot` from `src/metrics-frame.ts`; `readConnection`, `sameConnection`,
  `DEFAULT_HOST`, `DEFAULT_PORT` from `src/connection-settings.ts`; `buildUserAgent` from
  `src/user-agent.ts`; `GlobalSettings` from `src/types.ts`.
- Produces: `metricsManager`, a singleton with `initialize(): Promise<void>`, `acquire(): void`,
  `release(): void`, `on(listener: (event: MetricsEvent) => void): () => void`, and the getters
  `snapshot: Snapshot | null`, `health: HealthState | null`, `socketUp: boolean`,
  `ageMs: number | null`.

- [ ] **Step 1: Write the module**

Create `src/metrics-manager.ts`:

```ts
import WebSocket from "ws";
import streamDeck from "@elgato/streamdeck";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  readConnection,
  sameConnection,
} from "./connection-settings";
import { MetricsCore, type MetricsEvent } from "./metrics-core";
import { parseMetricsFrame, type HealthState, type Snapshot } from "./metrics-frame";
import type { GlobalSettings } from "./types";
import { buildUserAgent } from "./user-agent";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const STABLE_THRESHOLD_MS = 30000;
const WATCHDOG_MS = 1000;

/**
 * The `/metrics` subscription.
 *
 * A second socket rather than a second use of the command socket: this route is push-only,
 * authenticates at the handshake instead of per message, and carries a frame every second. It
 * shares nothing with the command protocol but the host, the port and the key.
 *
 * Opened only while a stat key is on screen. A user with no stat key never opens it, and the
 * client never pushes diagnostics into a plugin that would discard them.
 */
class MetricsManager {
  private ws: WebSocket | null = null;
  private host = DEFAULT_HOST;
  private port = DEFAULT_PORT;
  private key = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private backoffAttempts = 0;
  private intentionalClose = false;
  private listeners = new Set<(event: MetricsEvent) => void>();
  private userAgent = buildUserAgent(undefined);
  private readonly core = new MetricsCore();

  get snapshot(): Snapshot | null {
    return this.core.snapshot;
  }

  get health(): HealthState | null {
    return this.core.health;
  }

  get socketUp(): boolean {
    return this.core.socketUp;
  }

  get ageMs(): number | null {
    return this.core.ageMs(Date.now());
  }

  /** Read settings and watch for changes. Opens nothing: that waits for a stat key. */
  async initialize(): Promise<void> {
    this.userAgent = buildUserAgent(this.pluginVersion());

    this.applySettings(await streamDeck.settings.getGlobalSettings<GlobalSettings>());

    streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
      if (!this.applySettings(ev.settings)) return;
      if (!this.core.subscribed) return;

      streamDeck.logger.info("Metrics settings changed, reconnecting...");
      this.closeSocket();
      this.backoffAttempts = 0;
      this.openSocket();
    });
  }

  on(listener: (event: MetricsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A stat key appeared. */
  acquire(): void {
    if (this.core.acquire() !== "open") return;
    this.backoffAttempts = 0;
    this.openSocket();
  }

  /** A stat key went away. */
  release(): void {
    if (this.core.release() !== "close") return;
    this.closeSocket();
  }

  private pluginVersion(): string | undefined {
    try {
      return streamDeck.info.plugin.version;
    } catch {
      return undefined;
    }
  }

  /** Returns true when the endpoint changed. */
  private applySettings(settings: GlobalSettings): boolean {
    const next = readConnection(settings);
    const changed = !sameConnection(next, {
      host: this.host,
      port: this.port,
      key: this.key,
    });

    this.host = next.host;
    this.port = next.port;
    this.key = next.key;
    return changed;
  }

  private openSocket(): void {
    this.clearReconnect();

    if (this.ws !== null) {
      this.intentionalClose = true;
      this.ws.terminate();
      this.ws = null;
    }

    // The route refuses an upgrade with no key whenever the client has one configured, so an
    // attempt without one can only fail the handshake.
    if (this.key === "") {
      streamDeck.logger.warn(
        "No authentication key configured. The metrics stream cannot be subscribed to " +
          "without one.",
      );
      return;
    }

    this.intentionalClose = false;
    const url = `ws://${this.host}:${this.port}/metrics?key=${encodeURIComponent(this.key)}`;
    streamDeck.logger.info(`Subscribing to BVC metrics at ${this.host}:${this.port}/metrics`);

    const ws = new WebSocket(url, {
      maxPayload: 256 * 1024,
      headers: { "User-Agent": this.userAgent },
    });
    this.ws = ws;

    ws.on("error", (err) => {
      if (this.ws !== ws) return; // stale socket
      streamDeck.logger.error(`Metrics WebSocket error: ${err.message}`);
    });

    ws.on("open", () => {
      if (this.ws !== ws) return; // stale socket
      streamDeck.logger.info("Subscribed to BVC metrics");
      this.emit(this.core.setSocketUp(true));
      this.startWatchdog();
      this.startStableTimer();
    });

    ws.on("close", () => {
      if (this.ws !== ws) return; // stale socket — a new connection is already active
      this.stopWatchdog();
      this.stopStableTimer();
      this.ws = null;
      this.emit(this.core.setSocketUp(false));

      if (!this.intentionalClose && this.core.subscribed) {
        this.scheduleReconnect();
      }
    });

    ws.on("message", (raw) => {
      if (this.ws !== ws) return; // stale socket
      this.emit(this.core.applyFrame(parseMetricsFrame(raw.toString()), Date.now()));
    });
  }

  private closeSocket(): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.stopWatchdog();
    this.stopStableTimer();

    if (this.ws !== null) {
      this.ws.terminate();
      this.ws = null;
    }

    this.emit(this.core.setSocketUp(false));
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.backoffAttempts),
      RECONNECT_MAX_MS,
    );
    this.backoffAttempts++;
    streamDeck.logger.info(`Resubscribing to metrics in ${delay}ms (attempt ${this.backoffAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.core.subscribed) this.openSocket();
    }, delay);
  }

  /**
   * The staleness watchdog.
   *
   * No ping rides this route — nothing reads inbound frames on the client side, so a keepalive
   * would be answered by nothing. What matters is whether the data is current, and a client
   * whose voice session is down stops pushing while its socket stays perfectly healthy.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      this.emit(this.core.tick(Date.now()));
    }, WATCHDOG_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer === null) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private startStableTimer(): void {
    this.stableTimer = setTimeout(() => {
      this.backoffAttempts = 0;
    }, STABLE_THRESHOLD_MS);
  }

  private stopStableTimer(): void {
    if (this.stableTimer === null) return;
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private emit(events: readonly MetricsEvent[]): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }
}

export const metricsManager = new MetricsManager();
```

- [ ] **Step 2: Verify it typechecks**

Run: `yarn build`
Expected: no TypeScript errors.

- [ ] **Step 3: Run the whole suite**

Run: `yarn test`
Expected: PASS, all files. Nothing imports this module yet, so this only confirms nothing
regressed.

- [ ] **Step 4: Commit**

```bash
git add src/metrics-manager.ts
git commit -m "feat: subscribe to the client metrics stream"
```

---

### Task 11: The stat key

The action, its Property Inspector, and the dropdown that fills it.

**Files:**
- Create: `src/stat-items.ts`
- Create: `src/actions/stat.ts`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/ui/stat.html`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/stat/icon.svg`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/stat/key.svg`
- Modify: `src/types.ts`
- Modify: `src/plugin.ts`
- Modify: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json`
- Test: `tests/stat-items.test.ts`

**Interfaces:**
- Consumes: `metricsManager` (Task 10), `configuredPaths` and `statView` (Task 8),
  `renderStatKey` (Task 9), `flattenSnapshot` (Task 6), `labelFor` and `sectionFor` (Task 7),
  `DataSourceItem` and `DataSourceGroup` from `src/target-items.ts`.
- Produces:
  - `interface StatActionSettings { stat1?, stat2?, stat3?, stat4?: string }` in `src/types.ts`
  - `groupStats(snapshot: Snapshot | null): (DataSourceItem | DataSourceGroup)[]`
  - `StatAction`

- [ ] **Step 1: Write the failing test for the dropdown**

Create `tests/stat-items.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { groupStats } from "../src/stat-items";

const SNAPSHOT = {
  mic: { muted: false, device: "Yeti" },
  link: { rtt_ms: 42 },
  gpu: { temperature: 60 },
};

describe("groupStats", () => {
  test("offers a way to clear a slot before anything else", () => {
    const items = groupStats(SNAPSHOT);
    expect(items[0]).toEqual({ label: "None", value: "" });
  });

  test("groups the stats by section", () => {
    const groups = groupStats(SNAPSHOT).slice(1);
    expect(groups.map((group) => (group as { label: string }).label))
      .toEqual(["Link", "Microphone", "Other"]);
  });

  test("labels each entry and keeps its path as the value", () => {
    const groups = groupStats(SNAPSHOT).slice(1) as { label: string; children: unknown[] }[];
    const link = groups.find((group) => group.label === "Link");
    expect(link?.children).toEqual([{ label: "RTT", value: "link.rtt_ms" }]);
  });

  test("carries a stat the catalog has never seen", () => {
    const groups = groupStats(SNAPSHOT).slice(1) as { label: string; children: unknown[] }[];
    const other = groups.find((group) => group.label === "Other");
    expect(other?.children).toEqual([{ label: "TEMPERATURE", value: "gpu.temperature" }]);
  });

  test("says why there is nothing to pick when no snapshot has arrived", () => {
    expect(groupStats(null)).toEqual([
      { label: "Waiting for Bedrock Voice Chat", value: "", disabled: true },
    ]);
  });

  test("says the same for a snapshot carrying nothing selectable", () => {
    expect(groupStats({ peers: [] })).toEqual([
      { label: "Waiting for Bedrock Voice Chat", value: "", disabled: true },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test tests/stat-items.test.ts`
Expected: FAIL — cannot resolve `../src/stat-items`.

- [ ] **Step 3: Write the dropdown builder**

Create `src/stat-items.ts`:

```ts
import type { Snapshot } from "./metrics-frame";
import { labelFor, sectionFor, type StatSection } from "./stat-catalog";
import { flattenSnapshot } from "./stat-paths";
import type { DataSourceGroup, DataSourceItem } from "./target-items";

/** Sections in the order an operator reads them, link health first. */
const SECTION_ORDER: readonly StatSection[] = [
  "Link",
  "Microphone",
  "Playback",
  "Session",
  "Other",
];

const NONE: DataSourceItem = { label: "None", value: "" };

const WAITING: DataSourceItem = {
  label: "Waiting for Bedrock Voice Chat",
  value: "",
  disabled: true,
};

/**
 * The dropdown contents for a snapshot.
 *
 * With nothing received the list is one disabled entry rather than an empty control, so the
 * reason there is nothing to pick is on the page instead of being inferred from a blank
 * dropdown. This is how the Connect key already reports an empty target list.
 */
export function groupStats(snapshot: Snapshot | null): (DataSourceItem | DataSourceGroup)[] {
  const entries = flattenSnapshot(snapshot);
  if (entries.length === 0) return [WAITING];

  const groups: DataSourceGroup[] = [];

  for (const section of SECTION_ORDER) {
    const children = entries
      .filter((entry) => sectionFor(entry.path) === section)
      .map((entry): DataSourceItem => ({ label: labelFor(entry.path), value: entry.path }));

    if (children.length > 0) groups.push({ label: section, children });
  }

  return [NONE, ...groups];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test tests/stat-items.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the settings type**

In `src/types.ts`, add after `ConnectActionSettings`:

```ts
/**
 * Settings for the Stat action — up to four snapshot paths, one per slot.
 *
 * Only the path is stored. Unlike the Connect key, no label is cached beside it: labels come
 * from the plugin's own catalog, or are derived from the path, so a key reads correctly with
 * the client shut.
 */
export interface StatActionSettings {
  stat1?: string;
  stat2?: string;
  stat3?: string;
  stat4?: string;
  [key: string]: boolean | number | string | null | undefined;
}
```

- [ ] **Step 6: Write the action**

Create `src/actions/stat.ts`:

```ts
import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { metricsManager } from "../metrics-manager";
import { renderStatKey } from "../stat-image";
import { groupStats } from "../stat-items";
import { configuredPaths, statView } from "../stat-view";
import type { StatActionSettings } from "../types";

const DATASOURCE_EVENT = "getStats";

/**
 * The stat key. A readout of up to four live numbers.
 *
 * A press does nothing on purpose: there is no command this key could send that its own display
 * would not contradict.
 *
 * The metrics subscription is reference counted here. Every key that appears takes a reference
 * and every key that goes away drops one, so the second socket exists only while something is
 * drawing from it.
 */
@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.stat" })
export class StatAction extends SingletonAction<StatActionSettings> {
  private subscribed = false;

  // Which key instances hold a reference. A set rather than a count because Stream Deck may
  // raise `willAppear` for a key that is already on screen, and a second reference for one key
  // would keep the socket open after that key had gone.
  private readonly appeared = new Set<string>();

  // The last image pushed per key, so a 1 Hz frame that changes nothing costs no redraw.
  private readonly lastImage = new Map<string, string>();

  override onWillAppear(ev: WillAppearEvent<StatActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      metricsManager.on(() => {
        void this.renderAll();
      });
    }

    if (!this.appeared.has(ev.action.id)) {
      this.appeared.add(ev.action.id);
      metricsManager.acquire();
    }

    if (ev.action.isKey()) {
      void this.render(ev.action, ev.payload.settings);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<StatActionSettings>): void {
    if (this.appeared.delete(ev.action.id)) {
      metricsManager.release();
    }
    this.lastImage.delete(ev.action.id);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<StatActionSettings>,
  ): Promise<void> {
    if (ev.action.isKey()) {
      await this.render(ev.action, ev.payload.settings);
    }
  }

  /** Fills the Property Inspector's four stat dropdowns. */
  override async onSendToPlugin(
    ev: SendToPluginEvent<JsonValue, StatActionSettings>,
  ): Promise<void> {
    const payload = ev.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    if ((payload as Record<string, unknown>).event !== DATASOURCE_EVENT) return;

    await streamDeck.ui.sendToPropertyInspector({
      event: DATASOURCE_EVENT,
      items: groupStats(metricsManager.snapshot),
    });
  }

  private async render(
    target: KeyAction<StatActionSettings>,
    settings: StatActionSettings,
  ): Promise<void> {
    const image = renderStatKey(
      statView({
        paths: configuredPaths(settings),
        snapshot: metricsManager.snapshot,
        ageMs: metricsManager.ageMs,
        health: metricsManager.health,
        socketUp: metricsManager.socketUp,
      }),
    );

    if (this.lastImage.get(target.id) === image) return;
    this.lastImage.set(target.id, image);
    await target.setImage(image);
  }

  private async renderAll(): Promise<void> {
    for (const instance of this.actions) {
      if (!instance.isKey()) continue;
      await this.render(instance, await instance.getSettings());
    }
  }
}
```

- [ ] **Step 7: Write the Property Inspector**

Create `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/ui/stat.html`:

```html
<!DOCTYPE html>
<html>

<head lang="en">
    <title>Bedrock Voice Chat — Stats</title>
    <meta charset="utf-8" />
    <script src="https://sdpi-components.dev/releases/v4/sdpi-components.js"></script>
</head>

<body>
    <sdpi-item label="Stat 1">
        <sdpi-select setting="stat1" datasource="getStats" showRefresh
            loading="Loading stats..."></sdpi-select>
    </sdpi-item>

    <sdpi-item label="Stat 2">
        <sdpi-select setting="stat2" datasource="getStats" showRefresh
            loading="Loading stats..."></sdpi-select>
    </sdpi-item>

    <sdpi-item label="Stat 3">
        <sdpi-select setting="stat3" datasource="getStats" showRefresh
            loading="Loading stats..."></sdpi-select>
    </sdpi-item>

    <sdpi-item label="Stat 4">
        <sdpi-select setting="stat4" datasource="getStats" showRefresh
            loading="Loading stats..."></sdpi-select>
    </sdpi-item>

    <sdpi-item label="Host">
        <sdpi-textfield setting="host" global placeholder="127.0.0.1"></sdpi-textfield>
    </sdpi-item>

    <sdpi-item label="Port">
        <sdpi-textfield setting="port" global placeholder="9595"
            pattern="^[0-9]{1,5}$"></sdpi-textfield>
    </sdpi-item>

    <sdpi-item label="Authentication Key">
        <sdpi-textfield setting="authenticationKey" global type="password"
            placeholder="Required"></sdpi-textfield>
    </sdpi-item>
</body>

</html>
```

- [ ] **Step 8: Draw the art**

`imgs/actions/stat/key.svg` — the manifest's static state, replaced by the live image as soon
as the key appears:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#19102f"/>
  <g transform="translate(38,38) scale(2.875)" opacity="0.4"
     stroke="#d6cbea" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>
  </g>
</svg>
```

`imgs/actions/stat/icon.svg` — the action list entry:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
  <g transform="translate(3,3) scale(0.5833333333333334)"
     stroke="#fbf8ff" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>
  </g>
</svg>
```

- [ ] **Step 9: Register the action and start the manager**

In `src/plugin.ts`, add the imports:

```ts
import { StatAction } from "./actions/stat";
import { metricsManager } from "./metrics-manager";
```

Add the registration after `ConnectAction`'s:

```ts
streamDeck.actions.registerAction(new StatAction());
```

And initialise the manager beside `wsManager`. `initialize` reads settings and watches for
changes; it opens no socket until a stat key appears:

```ts
streamDeck.connect().then(() => {
  wsManager.initialize();
  void metricsManager.initialize();
}).catch((err) => {
  streamDeck.logger.error("Failed to initialize:", err);
});
```

- [ ] **Step 10: Add the manifest entry**

In `manifest.json`, add this object to the end of the `Actions` array, after the Connect entry:

```json
        {
            "Name": "Stats",
            "UUID": "com.alaydriem.bedrock-voice-chat.streamdeck.stat",
            "Icon": "imgs/actions/stat/icon",
            "Tooltip": "Show up to four live Bedrock Voice Chat statistics",
            "PropertyInspectorPath": "ui/stat.html",
            "Controllers": [
                "Keypad"
            ],
            "States": [
                {
                    "Image": "imgs/actions/stat/key",
                    "ShowTitle": false
                }
            ]
        }
```

- [ ] **Step 11: Run everything**

Run: `yarn test`
Expected: PASS, all files.

Run: `yarn build`
Expected: no TypeScript errors.

Run: `npx streamdeck validate com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin`
Expected: no errors.

- [ ] **Step 12: Try it against a running client**

Run: `npx streamdeck restart com.alaydriem.bedrock-voice-chat.streamdeck`

With Bedrock Voice Chat running and connected to a world, check each of these:

1. Drag a Stats key onto the Stream Deck. It draws `NO STATS`.
2. Open its Property Inspector. The four dropdowns fill, grouped Link, Microphone, Playback,
   Session.
3. Pick `RTT`. The key draws one large number that changes about once a second.
4. Pick three more. The layout becomes a 2x2 grid, and every cell stays inside its quarter.
5. Shut Bedrock Voice Chat. Within about three seconds the key stops showing numbers and
   reaches `NO CLIENT` rather than freezing on its last reading.
6. Start it again. The key refills without a restart.
7. Delete the key. Confirm in the client's connection pane that the `metrics` row goes away,
   leaving only the `command` row.

- [ ] **Step 13: Commit**

```bash
git add src/actions/stat.ts src/stat-items.ts src/types.ts src/plugin.ts \
  tests/stat-items.test.ts \
  com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json \
  com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/ui/stat.html \
  com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/stat
git commit -m "feat: add a live stat key"
```

---

## Done when

- `yarn test` passes, with the new suites: `connection-settings`, `metrics-frame`,
  `metrics-core`, `stat-paths`, `stat-catalog`, `stat-view`, `stat-image`, `stat-items`, plus
  the extended `frame` suite.
- `yarn build` produces no TypeScript errors.
- `npx streamdeck validate` reports no errors.
- Both hand checks pass: Task 2 Step 7 for the jukebox key, and Task 11 Step 12 for the stat
  key.
