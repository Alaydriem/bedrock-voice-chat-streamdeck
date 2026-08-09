# Connect Targets and a Mode-Aware Microphone Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Stream Deck key that connects to and disconnects from Bedrock Voice Chat Realms and proxies, make the microphone key toggle or hold depending on the client's voice mode, and fix the two client changes that break the existing keys.

**Architecture:** The plugin already has the right shape — a `wsManager` singleton owns the socket and mirrors the client's state, and actions subscribe to it and redraw. This extends that. Everything fragile is pulled out into pure modules (`frame.ts`, `pending-requests.ts`, `ptt-holds.ts`, `target-items.ts`, `connect-controller.ts`) that can be unit tested with no socket and no Stream Deck SDK; `ws-manager.ts` stays transport plus state mirror, and the actions stay thin.

**Tech Stack:** TypeScript (ES2022, `moduleResolution: Bundler`), `@elgato/streamdeck` v2, `ws` v8, Rollup, sdpi-components v4 for the Property Inspector, Vitest for unit tests.

**Design spec:** `docs/superpowers/specs/2026-08-09-connect-targets-and-ptt-design.md`

## Global Constraints

- **The auth key is mandatory.** Every command frame carries `key`. Without a key configured the plugin does not open a socket at all.
- **Target ids are opaque.** Store and quote back `{source}:{native}` strings verbatim. Never parse them, never split on `:`, never match a target by list position.
- **Wire field names are snake_case**: `voice_mode`, `ptt_active`, `connection`. TypeScript-side names are camelCase; the boundary is `frame.ts` and nowhere else.
- **Nothing is drawn optimistically.** Icons come only from state the client reported.
- **No `console.log`.** Use `streamDeck.logger`.
- **Style:** camelCase values and functions, PascalCase types, UPPER_SNAKE_CASE constants, `interface` for object shapes, `type` for unions. No `any` — use `unknown` and narrow. Immutable updates. Files under 400 lines.
- **Commits:** conventional commits (`feat:`, `fix:`, `test:`, `chore:`). semantic-release reads these, so `feat:` and `fix:` cut releases.
- **Existing behaviour must not regress:** reconnect backoff, the 15 s ping keepalive, the 30 s stability reset, and the `User-Agent` on the upgrade request all stay exactly as they are.

---

### Task 1: Vitest setup and frame discrimination

The client's `ResponseData` is an untagged Rust enum, so responses are discriminated by which
fields are present. This is the only place wire names are translated.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/frame.ts`
- Create: `tests/frame.test.ts`
- Modify: `src/types.ts` (add the protocol types the frame parser returns)
- Modify: `package.json` (add vitest, add the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ConnectTargetKind = "proxy" | "realm"`, `VoiceMode = "openMic" | "pushToTalk"`
  - `interface ConnectTarget { id: string; name: string; kind: ConnectTargetKind }`
  - `interface ActiveConnection { id: string; name: string; kind: ConnectTargetKind }`
  - `interface StateFrameData { muted, deafened, recording: boolean; voiceMode: VoiceMode | null; pttActive: boolean; connection: ActiveConnection | null }`
  - `type BvcFrame` (discriminated on `kind`), `parseFrame(raw: string): BvcFrame`

- [ ] **Step 1: Install Vitest and add the test script**

```bash
yarn add -D vitest
```

Then edit `package.json` so the `scripts` block reads:

```json
    "scripts": {
        "build": "rollup -c",
        "watch": "rollup -c -w --watch.onEnd=\"streamdeck restart com.alaydriem.bedrock-voice-chat.streamdeck\"",
        "package": "streamdeck pack com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin",
        "test": "vitest run"
    },
```

- [ ] **Step 2: Add the Vitest config**

Create `vitest.config.ts`. Tests live outside `src/` so the Rollup build and its `tsconfig`
`include` are untouched — Rollup only compiles the module graph reachable from
`src/plugin.ts`, and Vitest transpiles without typechecking.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Add the protocol types**

Replace the whole of `src/types.ts` with this. It is the final shape for the feature; later
tasks only read from it.

```ts
export type ConnectTargetKind = "proxy" | "realm";
export type VoiceMode = "openMic" | "pushToTalk";

/** One world the client can be asked to connect to. `id` is opaque — never parse it. */
export interface ConnectTarget {
  id: string;
  name: string;
  kind: ConnectTargetKind;
}

/** The world a session is running against right now. */
export interface ActiveConnection {
  id: string;
  name: string;
  kind: ConnectTargetKind;
}

export type BvcCommand =
  | { action: "ping" }
  | { action: "mute"; device: "input" | "output" }
  | { action: "record" }
  | { action: "state" }
  | { action: "ptt"; down: boolean }
  | { action: "targets" }
  | { action: "connect"; id: string }
  | { action: "disconnect" };

/**
 * The client's state as the plugin mirrors it.
 *
 * `null` means "not known", which is why every field that can be reported is nullable:
 * `connected` says whether the socket is up, and the rest are only meaningful when it is.
 */
export interface BvcState {
  connected: boolean;
  inputMuted: boolean | null;
  outputMuted: boolean | null;
  recording: boolean | null;
  voiceMode: VoiceMode | null;
  pttActive: boolean | null;
  connection: ActiveConnection | null;
  targets: readonly ConnectTarget[];
}

export type BvcStateEvent =
  | { type: "connectionChanged"; connected: boolean }
  | { type: "inputMuteChanged"; muted: boolean | null }
  | { type: "outputMuteChanged"; muted: boolean | null }
  | { type: "recordingChanged"; recording: boolean | null }
  | { type: "voiceModeChanged"; voiceMode: VoiceMode | null }
  | { type: "pttActiveChanged"; active: boolean | null }
  | { type: "activeConnectionChanged"; connection: ActiveConnection | null }
  | { type: "targetsChanged"; targets: readonly ConnectTarget[] };

export type GlobalSettings = {
  host?: string;
  port?: string;
  authenticationKey?: string;
  [key: string]: boolean | number | string | null | undefined;
};

/** Settings for the Connect action. `targetName` is cached so the key reads correctly offline. */
export interface ConnectActionSettings {
  targetId?: string;
  targetName?: string;
  targetKind?: ConnectTargetKind;
  [key: string]: boolean | number | string | null | undefined;
}

/** Actions with nothing to configure: mute, deafen, record, ptt. */
export type ActionSettings = Record<string, never>;
```

- [ ] **Step 4: Write the failing tests**

Create `tests/frame.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { parseFrame } from "../src/frame";

const wrap = (data: unknown): string => JSON.stringify({ success: true, data });

describe("parseFrame", () => {
  test("returns unknown for text that is not JSON", () => {
    expect(parseFrame("not json").kind).toBe("unknown");
  });

  test("returns unknown for a JSON array", () => {
    expect(parseFrame("[1,2,3]").kind).toBe("unknown");
  });

  test("reads an error frame", () => {
    const frame = parseFrame(JSON.stringify({ success: false, error: "Invalid authentication key" }));
    expect(frame).toEqual({ kind: "error", message: "Invalid authentication key" });
  });

  test("reads an error frame with no message", () => {
    const frame = parseFrame(JSON.stringify({ success: false }));
    expect(frame).toEqual({ kind: "error", message: "unknown error" });
  });

  test("reads a pong", () => {
    expect(parseFrame(wrap({ pong: true })).kind).toBe("pong");
  });

  test("reads a targets frame", () => {
    const frame = parseFrame(wrap({
      targets: [
        { id: "saved:abc", name: "My Server", kind: "proxy" },
        { id: "realm:12345", name: "My Realm", kind: "realm" },
      ],
    }));
    expect(frame).toEqual({
      kind: "targets",
      targets: [
        { id: "saved:abc", name: "My Server", kind: "proxy" },
        { id: "realm:12345", name: "My Realm", kind: "realm" },
      ],
    });
  });

  test("drops targets with an unrecognised kind rather than the whole list", () => {
    const frame = parseFrame(wrap({
      targets: [
        { id: "saved:abc", name: "Good", kind: "proxy" },
        { id: "weird:1", name: "Bad", kind: "hyperspace" },
      ],
    }));
    expect(frame).toEqual({
      kind: "targets",
      targets: [{ id: "saved:abc", name: "Good", kind: "proxy" }],
    });
  });

  test("reads an empty targets list", () => {
    expect(parseFrame(wrap({ targets: [] }))).toEqual({ kind: "targets", targets: [] });
  });

  test("reads a mute response and does not mistake it for state", () => {
    const frame = parseFrame(wrap({ device: "input", muted: true }));
    expect(frame).toEqual({ kind: "mute", device: "input", muted: true });
  });

  test("reads a full state frame with no active connection", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: true, recording: false,
      voice_mode: "openMic", ptt_active: false, connection: null,
    }));
    expect(frame).toEqual({
      kind: "state",
      state: {
        muted: false, deafened: true, recording: false,
        voiceMode: "openMic", pttActive: false, connection: null,
      },
    });
  });

  test("reads a full state frame carrying an active connection", () => {
    const frame = parseFrame(wrap({
      muted: true, deafened: false, recording: false,
      voice_mode: "pushToTalk", ptt_active: true,
      connection: { id: "realm:12345", name: "My Realm", kind: "realm" },
    }));
    expect(frame).toEqual({
      kind: "state",
      state: {
        muted: true, deafened: false, recording: false,
        voiceMode: "pushToTalk", pttActive: true,
        connection: { id: "realm:12345", name: "My Realm", kind: "realm" },
      },
    });
  });

  test("reports an unrecognised voice mode as not known", () => {
    const frame = parseFrame(wrap({
      muted: false, deafened: false, recording: false,
      voice_mode: "telepathy", ptt_active: false, connection: null,
    }));
    expect(frame.kind === "state" && frame.state.voiceMode).toBeNull();
  });

  test("reads a connect response and does not mistake it for record", () => {
    const frame = parseFrame(wrap({ connected: true, id: "saved:abc", name: "My Server" }));
    expect(frame).toEqual({ kind: "connect", connected: true, id: "saved:abc", name: "My Server" });
  });

  test("reads a disconnect response that found nothing running", () => {
    const frame = parseFrame(wrap({ connected: false, id: null, name: null }));
    expect(frame).toEqual({ kind: "connect", connected: false, id: null, name: null });
  });

  test("reads a record response", () => {
    expect(parseFrame(wrap({ recording: true }))).toEqual({ kind: "record", recording: true });
  });

  test("reads a ptt response", () => {
    expect(parseFrame(wrap({ active: true }))).toEqual({ kind: "ptt", active: true });
  });

  test("returns unknown for a success frame with no data", () => {
    expect(parseFrame(JSON.stringify({ success: true })).kind).toBe("unknown");
  });

  test("returns unknown for a data shape it does not recognise", () => {
    expect(parseFrame(wrap({ somethingNew: 42 })).kind).toBe("unknown");
  });
});
```

- [ ] **Step 5: Run the tests and confirm they fail**

Run: `yarn test`
Expected: FAIL — `Failed to resolve import "../src/frame"`.

- [ ] **Step 6: Implement the frame parser**

Create `src/frame.ts`. The check order matters and is what stops a `mute` response being read
as `state`, or a `connect` response as `record`.

```ts
import type { ActiveConnection, ConnectTarget, ConnectTargetKind, VoiceMode } from "./types";

/** The parsed contents of a state frame, whether solicited or broadcast. */
export interface StateFrameData {
  muted: boolean;
  deafened: boolean;
  recording: boolean;
  voiceMode: VoiceMode | null;
  pttActive: boolean;
  connection: ActiveConnection | null;
}

export type BvcFrame =
  | { kind: "error"; message: string }
  | { kind: "pong" }
  | { kind: "targets"; targets: ConnectTarget[] }
  | { kind: "mute"; device: "input" | "output"; muted: boolean }
  | { kind: "state"; state: StateFrameData }
  | { kind: "connect"; connected: boolean; id: string | null; name: string | null }
  | { kind: "record"; recording: boolean }
  | { kind: "ptt"; active: boolean }
  | { kind: "unknown" };

const UNKNOWN: BvcFrame = { kind: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toKind(value: unknown): ConnectTargetKind | null {
  return value === "proxy" || value === "realm" ? value : null;
}

function toVoiceMode(value: unknown): VoiceMode | null {
  return value === "openMic" || value === "pushToTalk" ? value : null;
}

/** A target or an active connection — the same three fields on the wire. */
function toTarget(value: unknown): ConnectTarget | null {
  if (!isRecord(value)) return null;
  const kind = toKind(value.kind);
  if (typeof value.id !== "string" || typeof value.name !== "string" || kind === null) {
    return null;
  }
  return { id: value.id, name: value.name, kind };
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Turn one raw WebSocket message into a frame.
 *
 * The client's `ResponseData` is an untagged enum, so the shape is all there is to go on.
 * The order below has no collisions against the current payloads: `mute` is checked before
 * `state` because a mute response also carries `muted`, and `connect` before `record`
 * because a record response is the more permissive shape of the two.
 */
export function parseFrame(raw: string): BvcFrame {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return UNKNOWN;
  }

  if (!isRecord(message)) return UNKNOWN;

  if (message.success === false) {
    return { kind: "error", message: toOptionalString(message.error) ?? "unknown error" };
  }

  const data = message.data;
  if (!isRecord(data)) return UNKNOWN;

  if (data.pong === true) return { kind: "pong" };

  if (Array.isArray(data.targets)) {
    const targets = data.targets
      .map(toTarget)
      .filter((target): target is ConnectTarget => target !== null);
    return { kind: "targets", targets };
  }

  if ((data.device === "input" || data.device === "output") && typeof data.muted === "boolean") {
    return { kind: "mute", device: data.device, muted: data.muted };
  }

  if (
    typeof data.muted === "boolean" &&
    typeof data.deafened === "boolean" &&
    typeof data.recording === "boolean"
  ) {
    return {
      kind: "state",
      state: {
        muted: data.muted,
        deafened: data.deafened,
        recording: data.recording,
        voiceMode: toVoiceMode(data.voice_mode),
        pttActive: data.ptt_active === true,
        connection: toTarget(data.connection),
      },
    };
  }

  if (typeof data.connected === "boolean") {
    return {
      kind: "connect",
      connected: data.connected,
      id: toOptionalString(data.id),
      name: toOptionalString(data.name),
    };
  }

  if (typeof data.recording === "boolean") return { kind: "record", recording: data.recording };
  if (typeof data.active === "boolean") return { kind: "ptt", active: data.active };

  return UNKNOWN;
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `yarn test`
Expected: PASS, 18 tests.

- [ ] **Step 8: Commit**

```bash
git add package.json yarn.lock vitest.config.ts src/types.ts src/frame.ts tests/frame.test.ts
git commit -m "feat: parse the client's websocket frames by shape"
```

---

### Task 2: Request correlation

Replaces the single `pendingErrorCallback` in `ws-manager.ts:105`, which holds one in-flight
request and misattributes an error when two overlap.

**Files:**
- Create: `src/pending-requests.ts`
- Create: `tests/pending-requests.test.ts`

**Interfaces:**
- Consumes: `BvcFrame` from `src/frame.ts`, `ConnectTarget` from `src/types.ts`.
- Produces:
  - `REQUEST_TIMEOUT_MS = 10_000`, `MAX_PENDING = 16`
  - `interface PendingRequest { kind: "targets" | "other"; onError?: (message: string) => void; onTargets?: (targets: ConnectTarget[]) => void }`
  - `class PendingRequests` with `push(request)`, `settle(frame)`, `clear(message)`, `get size()`

- [ ] **Step 1: Write the failing tests**

Create `tests/pending-requests.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_PENDING, PendingRequests, REQUEST_TIMEOUT_MS } from "../src/pending-requests";
import type { BvcFrame } from "../src/frame";

const stateFrame: BvcFrame = {
  kind: "state",
  state: {
    muted: false, deafened: false, recording: false,
    voiceMode: "openMic", pttActive: false, connection: null,
  },
};
const errorFrame = (message: string): BvcFrame => ({ kind: "error", message });
const targetsFrame: BvcFrame = {
  kind: "targets",
  targets: [{ id: "saved:abc", name: "My Server", kind: "proxy" }],
};
const recordFrame: BvcFrame = { kind: "record", recording: true };

describe("PendingRequests", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("an error settles the oldest request", () => {
    const first = vi.fn();
    const second = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "other", onError: first });
    queue.push({ kind: "other", onError: second });

    queue.settle(errorFrame("boom"));

    expect(first).toHaveBeenCalledWith("boom");
    expect(second).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
  });

  test("a broadcast state frame does not settle anything", () => {
    const onError = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "other", onError });

    queue.settle(stateFrame);

    expect(queue.size).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test("a pong does not settle anything", () => {
    const queue = new PendingRequests();
    queue.push({ kind: "other" });
    queue.settle({ kind: "pong" });
    expect(queue.size).toBe(1);
  });

  test("an unrecognised frame does not settle anything", () => {
    const queue = new PendingRequests();
    queue.push({ kind: "other" });
    queue.settle({ kind: "unknown" });
    expect(queue.size).toBe(1);
  });

  test("a targets frame delivers to a targets request", () => {
    const onTargets = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "targets", onTargets });

    queue.settle(targetsFrame);

    expect(onTargets).toHaveBeenCalledWith([{ id: "saved:abc", name: "My Server", kind: "proxy" }]);
    expect(queue.size).toBe(0);
  });

  test("a response settles the oldest request even when it is not a targets frame", () => {
    const queue = new PendingRequests();
    queue.push({ kind: "other" });
    queue.push({ kind: "targets" });

    queue.settle(recordFrame);

    expect(queue.size).toBe(1);
  });

  test("a state frame arriving between a request and its response keeps the queue aligned", () => {
    const onTargets = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "targets", onTargets });

    queue.settle(stateFrame);
    queue.settle(targetsFrame);

    expect(onTargets).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
  });

  test("a timed out request stops calling back but still consumes its slot", () => {
    const onError = vi.fn();
    const onTargets = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "targets", onError, onTargets });

    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    expect(onError).toHaveBeenCalledOnce();
    expect(queue.size).toBe(1);

    queue.settle(targetsFrame);
    expect(onTargets).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
  });

  test("clear settles everything outstanding with the given message", () => {
    const first = vi.fn();
    const second = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "other", onError: first });
    queue.push({ kind: "targets", onError: second });

    queue.clear("socket closed");

    expect(first).toHaveBeenCalledWith("socket closed");
    expect(second).toHaveBeenCalledWith("socket closed");
    expect(queue.size).toBe(0);
  });

  test("clear stops a cleared request from timing out afterwards", () => {
    const onError = vi.fn();
    const queue = new PendingRequests();
    queue.push({ kind: "other", onError });

    queue.clear("socket closed");
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 2);

    expect(onError).toHaveBeenCalledOnce();
  });

  test("overflowing the cap clears the queue rather than growing past it", () => {
    const onError = vi.fn();
    const queue = new PendingRequests();
    for (let i = 0; i < MAX_PENDING; i++) queue.push({ kind: "other", onError });

    expect(queue.size).toBe(MAX_PENDING);
    queue.push({ kind: "other" });

    expect(queue.size).toBe(1);
    expect(onError).toHaveBeenCalledTimes(MAX_PENDING);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test tests/pending-requests.test.ts`
Expected: FAIL — `Failed to resolve import "../src/pending-requests"`.

- [ ] **Step 3: Implement the queue**

Create `src/pending-requests.ts`:

```ts
import type { BvcFrame } from "./frame";
import type { ConnectTarget } from "./types";

export const REQUEST_TIMEOUT_MS = 10_000;

/** A backstop, not a working limit. Reaching it means the client stopped answering. */
export const MAX_PENDING = 16;

export interface PendingRequest {
  readonly kind: "targets" | "other";
  readonly onError?: (message: string) => void;
  readonly onTargets?: (targets: ConnectTarget[]) => void;
}

interface Entry {
  readonly request: PendingRequest;
  abandoned: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Matches responses to the requests that caused them.
 *
 * A plain queue is enough because the client reads one frame, finishes the command, and
 * writes the response before reading again — responses cannot overtake each other.
 *
 * The one ambiguity is that a broadcast state frame is shape-identical to the response to a
 * `state` command. It is sidestepped rather than solved: `ping` and `state` are never
 * enqueued, so a state frame never has to decide whether it is a response, and never
 * settles anything.
 */
export class PendingRequests {
  private entries: Entry[] = [];

  constructor(private readonly timeoutMs: number = REQUEST_TIMEOUT_MS) {}

  get size(): number {
    return this.entries.length;
  }

  push(request: PendingRequest): void {
    if (this.entries.length >= MAX_PENDING) {
      this.clear("Bedrock Voice Chat stopped responding");
    }

    const entry: Entry = { request, abandoned: false, timer: null };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.abandoned) return;
      entry.abandoned = true;
      request.onError?.("Timed out waiting for Bedrock Voice Chat");
    }, this.timeoutMs);

    this.entries.push(entry);
  }

  /**
   * Settle whatever this frame answers.
   *
   * State, pong and unrecognised frames are left alone. The first two are ambiguous with
   * broadcasts; an unrecognised frame may be a broadcast this plugin does not parse, and
   * settling on one would put the queue permanently out of step. Leaving it costs at most
   * one entry, which its own timeout reclaims.
   */
  settle(frame: BvcFrame): void {
    if (frame.kind === "state" || frame.kind === "pong" || frame.kind === "unknown") {
      return;
    }

    const entry = this.shift();
    if (entry === undefined || entry.abandoned) return;

    if (frame.kind === "error") {
      entry.request.onError?.(frame.message);
      return;
    }

    if (frame.kind === "targets" && entry.request.kind === "targets") {
      entry.request.onTargets?.(frame.targets);
    }
  }

  /** Settle everything outstanding with an error. Used when the socket goes away. */
  clear(message: string): void {
    const entries = this.entries;
    this.entries = [];
    for (const entry of entries) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (!entry.abandoned) {
        entry.abandoned = true;
        entry.request.onError?.(message);
      }
    }
  }

  private shift(): Entry | undefined {
    const entry = this.entries.shift();
    if (entry?.timer != null) clearTimeout(entry.timer);
    return entry;
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test`
Expected: PASS, 30 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/pending-requests.ts tests/pending-requests.test.ts
git commit -m "feat: correlate websocket responses to the requests that caused them"
```

---

### Task 3: Property Inspector items

Turns a target list into the dropdown contents the Connect key's Property Inspector shows.

**Files:**
- Create: `src/target-items.ts`
- Create: `tests/target-items.test.ts`

**Interfaces:**
- Consumes: `ConnectTarget` from `src/types.ts`.
- Produces:
  - `interface DataSourceItem { label: string; value: string; disabled?: boolean }`
  - `interface DataSourceGroup { label: string; children: DataSourceItem[] }`
  - `groupTargets(targets: readonly ConnectTarget[]): (DataSourceItem | DataSourceGroup)[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/target-items.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { groupTargets } from "../src/target-items";
import type { ConnectTarget } from "../src/types";

describe("groupTargets", () => {
  test("groups proxies and realms separately", () => {
    const targets: ConnectTarget[] = [
      { id: "saved:a", name: "Alpha", kind: "proxy" },
      { id: "realm:3", name: "Charlie", kind: "realm" },
      { id: "server:h:1", name: "Bravo", kind: "proxy" },
    ];

    expect(groupTargets(targets)).toEqual([
      {
        label: "Proxies",
        children: [
          { label: "Alpha", value: "saved:a" },
          { label: "Bravo", value: "server:h:1" },
        ],
      },
      { label: "Realms", children: [{ label: "Charlie", value: "realm:3" }] },
    ]);
  });

  test("omits a group with no entries", () => {
    const targets: ConnectTarget[] = [{ id: "realm:3", name: "Charlie", kind: "realm" }];
    expect(groupTargets(targets)).toEqual([
      { label: "Realms", children: [{ label: "Charlie", value: "realm:3" }] },
    ]);
  });

  test("reports an empty list as a disabled entry rather than an empty dropdown", () => {
    expect(groupTargets([])).toEqual([
      { label: "No Realms or proxies available", value: "", disabled: true },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test tests/target-items.test.ts`
Expected: FAIL — `Failed to resolve import "../src/target-items"`.

- [ ] **Step 3: Implement the helper**

Create `src/target-items.ts`:

```ts
import type { ConnectTarget } from "./types";

/** One entry in an sdpi-components datasource dropdown. */
export interface DataSourceItem {
  label: string;
  value: string;
  disabled?: boolean;
}

/** A named group of entries. */
export interface DataSourceGroup {
  label: string;
  children: DataSourceItem[];
}

const EMPTY: DataSourceItem = {
  label: "No Realms or proxies available",
  value: "",
  disabled: true,
};

function toItem(target: ConnectTarget): DataSourceItem {
  return { label: target.name, value: target.id };
}

/**
 * The dropdown contents for a list of targets.
 *
 * An empty list becomes one disabled entry rather than an empty dropdown, so the reason the
 * user has nothing to pick is visible on the page instead of being inferred from a blank
 * control.
 */
export function groupTargets(
  targets: readonly ConnectTarget[],
): (DataSourceItem | DataSourceGroup)[] {
  const proxies = targets.filter((target) => target.kind === "proxy").map(toItem);
  const realms = targets.filter((target) => target.kind === "realm").map(toItem);

  const groups: DataSourceGroup[] = [];
  if (proxies.length > 0) groups.push({ label: "Proxies", children: proxies });
  if (realms.length > 0) groups.push({ label: "Realms", children: realms });

  return groups.length > 0 ? groups : [EMPTY];
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test`
Expected: PASS, 33 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/target-items.ts tests/target-items.test.ts
git commit -m "feat: group targets into property inspector dropdown items"
```

---

### Task 4: Push-to-talk hold tracking

The client deliberately does not close the microphone when a connection drops mid-hold, and
its `PttHold` has no watchdog. Owning the release is the plugin's job; this module is the
bookkeeping, kept out of the action so it can be tested without the SDK.

**Files:**
- Create: `src/ptt-holds.ts`
- Create: `tests/ptt-holds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PttHoldEvent = { type: "keyDown" | "keyUp" | "disappear"; actionId: string } | { type: "socketClosed" } | { type: "socketOpened" }`
  - `type PttHoldOutcome = "press" | "release" | "none"`
  - `class PttHolds` with `apply(event): PttHoldOutcome`, `get heldCount()`, `get hasPendingRelease()`

- [ ] **Step 1: Write the failing tests**

Create `tests/ptt-holds.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { PttHolds } from "../src/ptt-holds";

describe("PttHolds", () => {
  test("a press asks for a press", () => {
    const holds = new PttHolds();
    expect(holds.apply({ type: "keyDown", actionId: "a" })).toBe("press");
    expect(holds.heldCount).toBe(1);
  });

  test("a release after a press asks for a release", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });
    expect(holds.apply({ type: "keyUp", actionId: "a" })).toBe("release");
    expect(holds.heldCount).toBe(0);
  });

  test("a release with no press behind it asks for nothing", () => {
    const holds = new PttHolds();
    expect(holds.apply({ type: "keyUp", actionId: "a" })).toBe("none");
  });

  test("a key disappearing while held asks for a release", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });
    expect(holds.apply({ type: "disappear", actionId: "a" })).toBe("release");
  });

  test("a key disappearing while not held asks for nothing", () => {
    const holds = new PttHolds();
    expect(holds.apply({ type: "disappear", actionId: "a" })).toBe("none");
  });

  test("two keys are tracked apart", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });
    holds.apply({ type: "keyDown", actionId: "b" });
    expect(holds.apply({ type: "keyUp", actionId: "a" })).toBe("release");
    expect(holds.heldCount).toBe(1);
  });

  test("a socket dropping mid-hold defers the release to the next open", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });

    expect(holds.apply({ type: "socketClosed" })).toBe("none");
    expect(holds.heldCount).toBe(0);
    expect(holds.hasPendingRelease).toBe(true);

    expect(holds.apply({ type: "socketOpened" })).toBe("release");
  });

  test("the deferred release fires only once", () => {
    const holds = new PttHolds();
    holds.apply({ type: "keyDown", actionId: "a" });
    holds.apply({ type: "socketClosed" });

    expect(holds.apply({ type: "socketOpened" })).toBe("release");
    expect(holds.apply({ type: "socketOpened" })).toBe("none");
    expect(holds.hasPendingRelease).toBe(false);
  });

  test("a socket dropping with nothing held defers nothing", () => {
    const holds = new PttHolds();
    holds.apply({ type: "socketClosed" });
    expect(holds.apply({ type: "socketOpened" })).toBe("none");
  });

  test("an open with no drop behind it asks for nothing", () => {
    const holds = new PttHolds();
    expect(holds.apply({ type: "socketOpened" })).toBe("none");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test tests/ptt-holds.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ptt-holds"`.

- [ ] **Step 3: Implement the tracker**

Create `src/ptt-holds.ts`:

```ts
export type PttHoldEvent =
  | { type: "keyDown"; actionId: string }
  | { type: "keyUp"; actionId: string }
  | { type: "disappear"; actionId: string }
  | { type: "socketClosed" }
  | { type: "socketOpened" };

export type PttHoldOutcome = "press" | "release" | "none";

/**
 * Which push-to-talk keys are held, and when a release has to be sent.
 *
 * The client will not close the microphone on its own if a connection drops mid-hold — its
 * own `PttHold` has no watchdog and says so. So a drop while held is remembered as a debt
 * and paid on the next open, which is the first moment anything can be sent again.
 *
 * Held keys are tracked by action instance because a profile can carry more than one.
 */
export class PttHolds {
  private readonly held = new Set<string>();
  private releasePending = false;

  get heldCount(): number {
    return this.held.size;
  }

  get hasPendingRelease(): boolean {
    return this.releasePending;
  }

  apply(event: PttHoldEvent): PttHoldOutcome {
    switch (event.type) {
      case "keyDown":
        this.held.add(event.actionId);
        return "press";

      case "keyUp":
      case "disappear":
        return this.held.delete(event.actionId) ? "release" : "none";

      case "socketClosed":
        this.releasePending = this.held.size > 0;
        this.held.clear();
        return "none";

      case "socketOpened":
        if (!this.releasePending) return "none";
        this.releasePending = false;
        return "release";
    }
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test`
Expected: PASS, 43 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/ptt-holds.ts tests/ptt-holds.test.ts
git commit -m "feat: track push-to-talk holds so a dropped socket cannot leave a hot mic"
```

---

### Task 5: Press semantics

One place decides what pressing a target key means. It is used by the Connect key today, and
is kept separate from that action so the decision can be tested without the SDK.

**Files:**
- Create: `src/connect-controller.ts`
- Create: `tests/connect-controller.test.ts`

**Interfaces:**
- Consumes: `ActiveConnection`, `BvcCommand` from `src/types.ts`.
- Produces:
  - `interface ConnectTransport { readonly activeConnection: ActiveConnection | null; send(command: BvcCommand, onError: (message: string) => void): boolean }`
  - `pressTarget(transport: ConnectTransport, targetId: string, onError: (message: string) => void): boolean`
  - `isUnknownTargetError(message: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/connect-controller.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { isUnknownTargetError, pressTarget } from "../src/connect-controller";
import type { ActiveConnection, BvcCommand } from "../src/types";

function fakeTransport(activeConnection: ActiveConnection | null, sendResult = true) {
  const sent: BvcCommand[] = [];
  return {
    sent,
    transport: {
      activeConnection,
      send(command: BvcCommand): boolean {
        sent.push(command);
        return sendResult;
      },
    },
  };
}

const live: ActiveConnection = { id: "saved:a", name: "Alpha", kind: "proxy" };
const noop = (): void => {};

describe("pressTarget", () => {
  test("connects when nothing is running", () => {
    const { sent, transport } = fakeTransport(null);
    expect(pressTarget(transport, "saved:a", noop)).toBe(true);
    expect(sent).toEqual([{ action: "connect", id: "saved:a" }]);
  });

  test("disconnects when this key's own target is running", () => {
    const { sent, transport } = fakeTransport(live);
    pressTarget(transport, "saved:a", noop);
    expect(sent).toEqual([{ action: "disconnect" }]);
  });

  test("switches when a different target is running, disconnect first", () => {
    const { sent, transport } = fakeTransport(live);
    pressTarget(transport, "realm:3", noop);
    expect(sent).toEqual([
      { action: "disconnect" },
      { action: "connect", id: "realm:3" },
    ]);
  });

  test("reports failure when the socket refuses the frame", () => {
    const { transport } = fakeTransport(null, false);
    expect(pressTarget(transport, "saved:a", noop)).toBe(false);
  });

  test("reports failure when a switch cannot be sent", () => {
    const { transport } = fakeTransport(live, false);
    expect(pressTarget(transport, "realm:3", noop)).toBe(false);
  });
});

describe("isUnknownTargetError", () => {
  test("recognises the client's unknown-id error", () => {
    expect(isUnknownTargetError("No target with id saved:gone")).toBe(true);
  });

  test("does not match other errors", () => {
    expect(isUnknownTargetError("Invalid authentication key")).toBe(false);
    expect(isUnknownTargetError("Proxy is already running.")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `yarn test tests/connect-controller.test.ts`
Expected: FAIL — `Failed to resolve import "../src/connect-controller"`.

- [ ] **Step 3: Implement the controller**

Create `src/connect-controller.ts`:

```ts
import type { ActiveConnection, BvcCommand } from "./types";

/** What pressing a target key needs from the socket. Narrow, so it can be faked in tests. */
export interface ConnectTransport {
  readonly activeConnection: ActiveConnection | null;
  send(command: BvcCommand, onError: (message: string) => void): boolean;
}

/** The client's wording when a target id names nothing it knows about. */
const UNKNOWN_TARGET_PREFIX = "No target with id";

/**
 * What a press on a key bound to `targetId` means.
 *
 *  - its own world is running  -> stop it
 *  - a different world is running -> switch to this one
 *  - nothing is running -> start it
 *
 * The switch sends both frames without waiting. That is safe because the client reads one
 * frame at a time and finishes each command before reading the next, so the disconnect
 * always completes before the connect is even read. Each frame carries its own error
 * callback, so a failure in either is reported on its own terms.
 *
 * Nothing here draws anything. The state frame the client broadcasts afterwards is what
 * moves the icon, so a press that fails leaves the key showing what is actually true.
 */
export function pressTarget(
  transport: ConnectTransport,
  targetId: string,
  onError: (message: string) => void,
): boolean {
  const live = transport.activeConnection;

  if (live === null) {
    return transport.send({ action: "connect", id: targetId }, onError);
  }

  if (live.id === targetId) {
    return transport.send({ action: "disconnect" }, onError);
  }

  const stopped = transport.send({ action: "disconnect" }, onError);
  const started = transport.send({ action: "connect", id: targetId }, onError);
  return stopped && started;
}

/**
 * Whether an error means the plugin's target list is stale.
 *
 * This is the one failure a retry can fix, so it is the one that triggers a refetch.
 */
export function isUnknownTargetError(message: string): boolean {
  return message.startsWith(UNKNOWN_TARGET_PREFIX);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test`
Expected: PASS, 50 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/connect-controller.ts tests/connect-controller.test.ts
git commit -m "feat: press semantics for the connect key"
```

---

### Task 6: Rewire the socket manager

Makes the existing keys work against the new client and gives later tasks everything they
need. No unit tests: this is the socket edge, verified by the build and by hand.

**Files:**
- Modify: `src/ws-manager.ts` (substantial rewrite of the message and send paths; connect, reconnect, ping and stability logic all stay as they are)

**Interfaces:**
- Consumes: `parseFrame`/`BvcFrame` (Task 1), `PendingRequests` (Task 2), all types from `src/types.ts` (Task 1).
- Produces on the `wsManager` singleton:
  - `state: BvcState` — now including `voiceMode`, `pttActive`, `connection`, `targets`
  - `get activeConnection(): ActiveConnection | null` — satisfies `ConnectTransport`
  - `send(command: BvcCommand, opts?: { onError?: (message: string) => void; onTargets?: (targets: ConnectTarget[]) => void }): boolean`
  - `requestTargets(): Promise<readonly ConnectTarget[]>`
  - `on(listener: (event: BvcStateEvent) => void): () => void` — unchanged signature, more event types

- [ ] **Step 1: Replace the imports and the state block**

In `src/ws-manager.ts`, replace the import block at the top:

```ts
import WebSocket from "ws";
import streamDeck from "@elgato/streamdeck";
import { parseFrame, type BvcFrame, type StateFrameData } from "./frame";
import { PendingRequests } from "./pending-requests";
import type {
  ActiveConnection,
  BvcCommand,
  BvcState,
  BvcStateEvent,
  ConnectTarget,
  GlobalSettings,
} from "./types";
```

Then replace the `pendingErrorCallback` field and the `state` initialiser inside the class:

```ts
  private readonly pending = new PendingRequests();
  private userAgent = USER_AGENT_PRODUCT;

  public state: BvcState = {
    connected: false,
    inputMuted: null,
    outputMuted: null,
    recording: null,
    voiceMode: null,
    pttActive: null,
    connection: null,
    targets: [],
  };

  /** The world a session is running against, for `ConnectTransport`. */
  get activeConnection(): ActiveConnection | null {
    return this.state.connection;
  }
```

Delete the `private pendingErrorCallback: (() => void) | null = null;` line.

- [ ] **Step 2: Refuse to open a socket without an auth key**

The client now refuses every command when no key is configured, including `ping` — which
would leave the keepalive timing out and the socket reconnecting forever. So do not open one.

In `connect()`, immediately after the existing block that terminates any existing connection
and before `this.intentionalClose = false;`, insert:

```ts
    if (this.authenticationKey === "") {
      streamDeck.logger.warn(
        "No authentication key configured. Set one in the plugin settings — " +
          "Bedrock Voice Chat refuses every command without it.",
      );
      return;
    }
```

- [ ] **Step 3: Send the key on every frame, and enqueue what can be correlated**

Replace the whole `send` method:

```ts
  /**
   * Send a command.
   *
   * `key` rides on every frame: the client refuses anything without it.
   *
   * `ping` and `state` are deliberately not enqueued. Their responses are shape-identical
   * to the frames the client broadcasts unprompted, so enqueuing them would make every
   * broadcast look like it might be an answer.
   */
  send(
    command: BvcCommand,
    opts?: {
      onError?: (message: string) => void;
      onTargets?: (targets: ConnectTarget[]) => void;
    },
  ): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (command.action !== "ping" && command.action !== "state") {
      this.pending.push({
        kind: command.action === "targets" ? "targets" : "other",
        onError: opts?.onError,
        onTargets: opts?.onTargets,
      });
    }

    this.ws.send(JSON.stringify({ ...command, key: this.authenticationKey }));
    return true;
  }

  /** Ask the client what worlds it can connect to. */
  requestTargets(): Promise<readonly ConnectTarget[]> {
    return new Promise((resolve, reject) => {
      const sent = this.send(
        { action: "targets" },
        {
          onTargets: (targets) => resolve(targets),
          onError: (message) => reject(new Error(message)),
        },
      );
      if (!sent) {
        reject(new Error("Not connected to Bedrock Voice Chat"));
      }
    });
  }
```

- [ ] **Step 4: Parse incoming frames through the new pipeline**

Replace the whole `ws.on("message", …)` handler:

```ts
    ws.on("message", (raw) => {
      if (this.ws !== ws) return; // stale socket
      const frame = parseFrame(raw.toString());
      if (frame.kind === "unknown") {
        streamDeck.logger.warn("Ignoring unrecognised WebSocket frame");
      }
      this.pending.settle(frame);
      this.applyFrame(frame);
    });
```

- [ ] **Step 5: Replace `handleMessage` with `applyFrame` and the setters**

Delete the entire `handleMessage` method and `setDisconnectedState`, and add in their place:

```ts
  private applyFrame(frame: BvcFrame): void {
    switch (frame.kind) {
      case "error":
        // The pending queue has already told whoever asked. This is for the log.
        streamDeck.logger.warn(`BVC error: ${frame.message}`);
        return;

      case "pong":
        this.awaitingPong = false;
        return;

      case "mute":
        if (frame.device === "input") this.setInputMuted(frame.muted);
        else this.setOutputMuted(frame.muted);
        return;

      case "state":
        this.applyState(frame.state);
        return;

      case "record":
        this.setRecording(frame.recording);
        return;

      case "ptt":
        this.setPttActive(frame.active);
        return;

      case "targets":
        this.setTargets(frame.targets);
        return;

      case "connect":
        // Nothing to draw: the client broadcasts a full state frame either way, and that
        // is the only thing the icons follow.
        streamDeck.logger.info(
          frame.connected
            ? `Connected to ${frame.name ?? "a world"}`
            : `Disconnected from ${frame.name ?? "nothing"}`,
        );
        return;

      case "unknown":
        return;
    }
  }

  private applyState(state: StateFrameData): void {
    this.setInputMuted(state.muted);
    this.setOutputMuted(state.deafened);
    this.setRecording(state.recording);
    this.setVoiceMode(state.voiceMode);
    this.setPttActive(state.pttActive);
    this.setActiveConnection(state.connection);
  }

  /** Everything the client reports becomes unknown when the socket goes away. */
  private clearReportedState(): void {
    this.setInputMuted(null);
    this.setOutputMuted(null);
    this.setRecording(null);
    this.setVoiceMode(null);
    this.setPttActive(null);
    this.setActiveConnection(null);
  }

  private setInputMuted(muted: boolean | null): void {
    if (this.state.inputMuted === muted) return;
    this.state.inputMuted = muted;
    this.emit({ type: "inputMuteChanged", muted });
  }

  private setOutputMuted(muted: boolean | null): void {
    if (this.state.outputMuted === muted) return;
    this.state.outputMuted = muted;
    this.emit({ type: "outputMuteChanged", muted });
  }

  private setRecording(recording: boolean | null): void {
    if (this.state.recording === recording) return;
    this.state.recording = recording;
    this.emit({ type: "recordingChanged", recording });
  }

  private setVoiceMode(voiceMode: BvcState["voiceMode"]): void {
    if (this.state.voiceMode === voiceMode) return;
    this.state.voiceMode = voiceMode;
    this.emit({ type: "voiceModeChanged", voiceMode });
  }

  private setPttActive(active: boolean | null): void {
    if (this.state.pttActive === active) return;
    this.state.pttActive = active;
    this.emit({ type: "pttActiveChanged", active });
  }

  private setActiveConnection(connection: ActiveConnection | null): void {
    const current = this.state.connection;
    if (current?.id === connection?.id) return;
    this.state.connection = connection;
    this.emit({ type: "activeConnectionChanged", connection });
  }

  private setTargets(targets: readonly ConnectTarget[]): void {
    this.state.targets = targets;
    this.emit({ type: "targetsChanged", targets });
  }
```

- [ ] **Step 6: Ask for state and targets on open, and settle pending work on close**

Replace the `ws.on("open", …)` handler:

```ts
    ws.on("open", () => {
      if (this.ws !== ws) return; // stale socket
      streamDeck.logger.info("Connected to BVC");
      this.setConnected(true);
      this.send({ action: "state" });
      void this.requestTargets().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown error";
        streamDeck.logger.warn(`Could not list connect targets: ${message}`);
      });
      this.startPing();
      this.startStableTimer();
    });
```

In `ws.on("close", …)`, replace the `if (this.state.connected) { … }` block with:

```ts
      this.pending.clear("Disconnected from Bedrock Voice Chat");

      if (this.state.connected) {
        this.setConnected(false);
        this.clearReportedState();
      }
```

In `disconnect()`, make the same substitution — replace its `if (this.state.connected) { … }`
block with:

```ts
    this.pending.clear("Disconnected from Bedrock Voice Chat");
    if (this.state.connected) {
      this.setConnected(false);
      this.clearReportedState();
    }
```

- [ ] **Step 7: Update the three existing actions to the new `send` signature**

`send` now takes an options object rather than a bare callback. In each of
`src/actions/mute.ts`, `src/actions/deafen.ts` and `src/actions/record.ts`, change the
`onKeyDown` call. For `mute.ts`:

```ts
    const sent = wsManager.send(
      { action: "mute", device: "input" },
      { onError: () => void ev.action.showAlert() },
    );
```

For `deafen.ts` use `{ action: "mute", device: "output" }`, and for `record.ts` use
`{ action: "record" }`. Leave everything else in those three files alone for now.

- [ ] **Step 8: Build and confirm it compiles**

Run: `yarn build`
Expected: exit 0, no TypeScript errors. Confirm `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/bin/plugin.js` was rewritten.

- [ ] **Step 9: Run the tests**

Run: `yarn test`
Expected: PASS, 50 tests — nothing here should have changed them.

- [ ] **Step 10: Commit**

```bash
git add src/ws-manager.ts src/actions/mute.ts src/actions/deafen.ts src/actions/record.ts
git commit -m "fix: send the now-mandatory auth key on every command frame"
```

---

### Task 7: Icons and manifest

One new key artwork, one new microphone variant, and the manifest entries. Nothing is wired up
yet; this task is verified by the plugin still loading with the Connect action visible in the
Stream Deck app.

**Files:**
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/connect/{icon,key,key-on,key-off,key-disconnected}.svg`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs/actions/mute/key-live.svg`
- Modify: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json`
- Modify: `src/icons.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: four new entries on the `icons` object — `connectOn`, `connectOff`, `connectDisconnected`, `micLive`.

- [ ] **Step 1: Write the connect artwork**

Every file below follows the existing recipe exactly: a 144×144 ground, the glyph translated
to `(38,38)` and scaled `2.875`, stroke width `1.9`, round caps and joins. The glyph is a
plug. Idle uses the `#19102f` ground with a `#d6cbea` stroke; live uses the dim `#4c293b`
ground with a `#ff8266` stroke, matching `record/key-on` rather than `mute/key-off` — the
full coral ground means "attention", and being connected does not.

`imgs/actions/connect/key-off.svg` (idle — socket up, this world not running):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#19102f"/>
  <g transform="translate(38,38) scale(2.875)"
     stroke="#d6cbea" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>
  </g>
</svg>
```

`imgs/actions/connect/key-on.svg` (this world is running):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#4c293b"/>
  <g transform="translate(38,38) scale(2.875)"
     stroke="#ff8266" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>
  </g>
</svg>
```

`imgs/actions/connect/key-disconnected.svg` (no socket, no key, or no target chosen):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#19102f"/>
  <g transform="translate(38,38) scale(2.875)" opacity="0.4"
     stroke="#d6cbea" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/><path d="M4 4l16 16"/>
  </g>
</svg>
```

`imgs/actions/connect/key.svg` — the manifest default, byte-identical to
`key-disconnected.svg` above. Copy it.

`imgs/actions/connect/icon.svg` — the 20×20 action-list variant:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
  <g transform="translate(3,3) scale(0.5833333333333334)"
     stroke="#fbf8ff" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>
  </g>
</svg>
```

- [ ] **Step 2: Write the transmitting microphone artwork**

One file, `imgs/actions/mute/key-live.svg`. The microphone key needs a state that means
"transmitting right now" for push-to-talk, distinct from the full-coral `key-off` that means
"muted, pay attention". It is the existing mic glyph on the dim `#4c293b` ground, the same
treatment `record/key-on` uses.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" fill="#4c293b"/>
  <g transform="translate(38,38) scale(2.875)"
     stroke="#ff8266" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.5"/>
  </g>
</svg>
```

Push-to-talk's *resting* state needs no new asset: it reuses `mute/key-on`. Both it and
"unmuted in open mic" mean the microphone is in its normal state, which keeps transmitting as
the only thing that pops.

- [ ] **Step 4: Extend the icon paths**

Replace `src/icons.ts` with:

```ts
// Image paths for setImage() — relative to the sdPlugin root (no extension).
// Stream Deck resolves @2x variants automatically.

export const icons = {
  micOn:                  "imgs/actions/mute/key-on",
  micOff:                 "imgs/actions/mute/key-off",
  micLive:                "imgs/actions/mute/key-live",
  micDisconnected:        "imgs/actions/mute/key-disconnected",

  headphonesOn:           "imgs/actions/deafen/key-on",
  headphonesOff:          "imgs/actions/deafen/key-off",
  headphonesDisconnected: "imgs/actions/deafen/key-disconnected",

  recordOn:               "imgs/actions/record/key-on",
  recordOff:              "imgs/actions/record/key-off",
  recordDisconnected:     "imgs/actions/record/key-disconnected",

  connectOn:              "imgs/actions/connect/key-on",
  connectOff:             "imgs/actions/connect/key-off",
  connectDisconnected:    "imgs/actions/connect/key-disconnected",
};
```

- [ ] **Step 4: Relabel the Mute action and register the new one**

In `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json`, first change the
existing Mute entry's `Name` and `Tooltip`. Its `UUID`, `Icon` and `States` are untouched —
changing the UUID would silently drop the key from every profile that already has one.

```json
		{
			"Name": "Microphone",
			"UUID": "com.alaydriem.bedrock-voice-chat.streamdeck.mute",
			"Icon": "imgs/actions/mute/icon",
			"Tooltip": "Toggle mute, or hold to talk when Bedrock Voice Chat is in push-to-talk",
			"Controllers": [
				"Keypad"
			],
			"States": [
				{
					"Image": "imgs/actions/mute/key",
					"ShowTitle": false
				}
			]
		},
```

Then append this object to the `Actions` array, after the existing Record entry. It sets
`ShowTitle: true` because the world's name is what tells one Connect key from another, and it
is the only action with its own Property Inspector.

```json
		{
			"Name": "Connect",
			"UUID": "com.alaydriem.bedrock-voice-chat.streamdeck.connect",
			"Icon": "imgs/actions/connect/icon",
			"Tooltip": "Connect to a Realm or proxy in Bedrock Voice Chat",
			"PropertyInspectorPath": "ui/connect.html",
			"Controllers": [
				"Keypad"
			],
			"States": [
				{
					"Image": "imgs/actions/connect/key",
					"ShowTitle": true
				}
			]
		}
```

- [ ] **Step 5: Confirm the manifest is valid JSON and the build still passes**

Run: `node -e "JSON.parse(require('fs').readFileSync('com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json','utf8')); console.log('manifest ok')"`
Expected: `manifest ok`

Run: `yarn build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/imgs com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/manifest.json src/icons.ts
git commit -m "feat: artwork and manifest entry for the connect key"
```

---

### Task 8: The Connect action and its Property Inspector

**Files:**
- Create: `src/actions/connect.ts`
- Create: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/ui/connect.html`
- Modify: `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/ui/global-settings.html` (relabel the key field)
- Modify: `src/plugin.ts` (register the action)

**Interfaces:**
- Consumes: `pressTarget`, `isUnknownTargetError` (Task 5); `groupTargets` (Task 3); `wsManager` (Task 6); `icons` (Task 7); `ConnectActionSettings` (Task 1).
- Produces: `class ConnectAction`.

- [ ] **Step 1: Write the Property Inspector page**

Create `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/ui/connect.html`. A per-action
Property Inspector replaces the plugin-level one, so this page repeats the connection fields —
they are `global` settings and bind identically from any page.

```html
<!DOCTYPE html>
<html>

<head lang="en">
    <title>Bedrock Voice Chat — Connect</title>
    <meta charset="utf-8" />
    <script src="https://sdpi-components.dev/releases/v4/sdpi-components.js"></script>
</head>

<body>
    <sdpi-item label="Target">
        <sdpi-select setting="targetId" datasource="getTargets" showRefresh
            loading="Loading Realms and proxies..."></sdpi-select>
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

- [ ] **Step 2: Relabel the key on the global page**

In `com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/ui/global-settings.html`, change the
authentication key placeholder from `"Optional"` to `"Required"`:

```html
    <sdpi-item label="Authentication Key">
        <sdpi-textfield setting="authenticationKey" global type="password"
            placeholder="Required"></sdpi-textfield>
    </sdpi-item>
```

- [ ] **Step 3: Write the action**

Create `src/actions/connect.ts`:

```ts
import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { isUnknownTargetError, pressTarget } from "../connect-controller";
import { icons } from "../icons";
import { groupTargets } from "../target-items";
import type { ConnectActionSettings } from "../types";
import { wsManager } from "../ws-manager";

const DATASOURCE_EVENT = "getTargets";

@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.connect" })
export class ConnectAction extends SingletonAction<ConnectActionSettings> {
  private subscribed = false;

  override onWillAppear(ev: WillAppearEvent<ConnectActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      wsManager.on((event) => {
        if (event.type === "connectionChanged" || event.type === "activeConnectionChanged") {
          void this.renderAll();
        }
      });
    }
    if (ev.action.isKey()) {
      void this.render(ev.action, ev.payload.settings);
    }
  }

  /**
   * The Property Inspector writes only the id. The name is resolved here and cached, so a
   * key still reads correctly when the client is not running.
   */
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ConnectActionSettings>,
  ): Promise<void> {
    const settings = ev.payload.settings;
    const target = wsManager.state.targets.find((entry) => entry.id === settings.targetId);

    if (target !== undefined && target.name !== settings.targetName) {
      await ev.action.setSettings({
        ...settings,
        targetName: target.name,
        targetKind: target.kind,
      });
      return; // setSettings re-enters here with the cached name in place
    }

    if (ev.action.isKey()) {
      await this.render(ev.action, settings);
    }
  }

  override async onKeyDown(ev: KeyDownEvent<ConnectActionSettings>): Promise<void> {
    const targetId = ev.payload.settings.targetId;
    if (targetId === undefined || targetId === "") {
      streamDeck.logger.warn("Connect key pressed with no target configured");
      await ev.action.showAlert();
      return;
    }

    const sent = pressTarget(wsManager, targetId, (message) => {
      streamDeck.logger.warn(`Connect failed: ${message}`);
      if (isUnknownTargetError(message)) {
        void wsManager.requestTargets().catch(() => {
          // The refetch is best effort; the alert has already been raised.
        });
      }
      void ev.action.showAlert();
    });

    if (!sent) {
      await ev.action.showAlert();
    }
  }

  /** Fills the Property Inspector's target dropdown. */
  override async onSendToPlugin(
    ev: SendToPluginEvent<JsonValue, ConnectActionSettings>,
  ): Promise<void> {
    const payload = ev.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    if ((payload as Record<string, unknown>).event !== DATASOURCE_EVENT) return;

    try {
      const targets = await wsManager.requestTargets();
      await streamDeck.ui.sendToPropertyInspector({
        event: DATASOURCE_EVENT,
        items: groupTargets(targets),
      });
    } catch (error: unknown) {
      // The client's own wording is more useful than anything invented here — "Xbox Live
      // authentication required" tells the user exactly what to go and do.
      const message = error instanceof Error
        ? error.message
        : "Bedrock Voice Chat is unavailable";
      await streamDeck.ui.sendToPropertyInspector({
        event: DATASOURCE_EVENT,
        items: [{ label: message, value: "", disabled: true }],
      });
    }
  }

  private async render(
    target: KeyAction<ConnectActionSettings>,
    settings: ConnectActionSettings,
  ): Promise<void> {
    await target.setImage(this.icon(settings));
    await target.setTitle(settings.targetName ?? "");
  }

  private async renderAll(): Promise<void> {
    for (const instance of this.actions) {
      if (!instance.isKey()) continue;
      const settings = await instance.getSettings();
      await this.render(instance, settings);
    }
  }

  private icon(settings: ConnectActionSettings): string {
    const state = wsManager.state;
    if (!state.connected || settings.targetId === undefined || settings.targetId === "") {
      return icons.connectDisconnected;
    }
    return state.connection?.id === settings.targetId ? icons.connectOn : icons.connectOff;
  }
}
```

- [ ] **Step 4: Register the action**

`src/plugin.ts` in full. This is its final state — Task 9 modifies an existing action rather
than adding one, so this file is not touched again.

```ts
import streamDeck from "@elgato/streamdeck";
import { MuteAction } from "./actions/mute";
import { DeafenAction } from "./actions/deafen";
import { RecordAction } from "./actions/record";
import { ConnectAction } from "./actions/connect";
import { wsManager } from "./ws-manager";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new MuteAction());
streamDeck.actions.registerAction(new DeafenAction());
streamDeck.actions.registerAction(new RecordAction());
streamDeck.actions.registerAction(new ConnectAction());

streamDeck.connect().then(() => {
  wsManager.initialize();
}).catch((err) => {
  streamDeck.logger.error("Failed to initialize:", err);
});
```

- [ ] **Step 5: Build and confirm it compiles**

Run: `yarn build`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/actions/connect.ts src/plugin.ts com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/ui
git commit -m "feat: connect key with a live Realm and proxy picker"
```

---

### Task 9: One microphone key that toggles or holds

The Mute key becomes mode-aware rather than gaining a sibling. `voice_mode` exists on the wire
so a controller can retarget one control: in `openMic` the key toggles, in `pushToTalk` it
holds. Two separate keys would each be dead half the time, because `VoiceModeGuard` refuses
input mute in `pushToTalk` and refuses `ptt` in `openMic`.

The UUID does not change. It is the action's identity in every saved profile.

**Files:**
- Modify: `src/actions/mute.ts` (becomes the microphone key)

**Interfaces:**
- Consumes: `PttHolds` (Task 4); `wsManager` (Task 6); `icons` (Task 7); `ActionSettings` (Task 1).
- Produces: `class MuteAction`, unchanged in name and UUID so `src/plugin.ts` needs no edit.

- [ ] **Step 1: Rewrite the microphone action**

Replace `src/actions/mute.ts` with:

```ts
import streamDeck, {
  action,
  SingletonAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { icons } from "../icons";
import { PttHolds } from "../ptt-holds";
import type { ActionSettings } from "../types";
import { wsManager } from "../ws-manager";

/**
 * The microphone key. One control, two behaviours, chosen by the client's voice mode:
 *
 *  - open mic      press toggles input mute; the release means nothing
 *  - push-to-talk  press opens the microphone, release closes it
 *
 * The mode is not a plugin setting. It is whatever the client last reported, which is why
 * `voice_mode` rides every state frame — a key that offered a toggle in push-to-talk would
 * be a second word for a state the hold already owns, and the client refuses it outright.
 *
 * The release is owned here. The client will not close the microphone by itself if the
 * connection drops mid-hold, so a release is sent on key up, on the key going away, and once
 * on the next open after a drop.
 */
@action({ UUID: "com.alaydriem.bedrock-voice-chat.streamdeck.mute" })
export class MuteAction extends SingletonAction<ActionSettings> {
  private subscribed = false;
  private readonly holds = new PttHolds();

  override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
    if (!this.subscribed) {
      this.subscribed = true;
      wsManager.on((event) => {
        if (event.type === "connectionChanged") {
          const outcome = this.holds.apply({
            type: event.connected ? "socketOpened" : "socketClosed",
          });
          if (outcome === "release") this.sendRelease();
        }
        if (
          event.type === "connectionChanged" ||
          event.type === "inputMuteChanged" ||
          event.type === "voiceModeChanged" ||
          event.type === "pttActiveChanged"
        ) {
          this.updateAllIcons();
        }
      });
    }
    if (ev.action.isKey()) {
      void ev.action.setImage(this.getIcon());
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    if (this.holds.apply({ type: "disappear", actionId: ev.action.id }) === "release") {
      this.sendRelease();
    }
  }

  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const mode = wsManager.state.voiceMode;

    // No state frame has arrived, so which command this key means is not yet known.
    if (mode === null) {
      await ev.action.showAlert();
      return;
    }

    const command = mode === "pushToTalk"
      ? ({ action: "ptt", down: true } as const)
      : ({ action: "mute", device: "input" } as const);

    if (mode === "pushToTalk") {
      this.holds.apply({ type: "keyDown", actionId: ev.action.id });
    }

    const sent = wsManager.send(command, {
      onError: () => void ev.action.showAlert(),
    });
    if (!sent) {
      await ev.action.showAlert();
    }
  }

  override async onKeyUp(ev: KeyUpEvent<ActionSettings>): Promise<void> {
    // In open mic the press already did the work; a toggle has no release.
    if (this.holds.apply({ type: "keyUp", actionId: ev.action.id }) !== "release") return;

    const sent = wsManager.send(
      { action: "ptt", down: false },
      { onError: () => void ev.action.showAlert() },
    );
    if (!sent) {
      await ev.action.showAlert();
    }
  }

  /** A release nobody asked for: a key going away, or a socket coming back after a drop. */
  private sendRelease(): void {
    if (!wsManager.send({ action: "ptt", down: false })) {
      streamDeck.logger.warn("Could not release push-to-talk; the socket is not open");
    }
  }

  private getIcon(): string {
    const state = wsManager.state;
    if (!state.connected || state.voiceMode === null || state.inputMuted === null) {
      return icons.micDisconnected;
    }

    if (state.voiceMode === "pushToTalk") {
      // Resting shares its artwork with an unmuted open mic: both mean the microphone is in
      // its normal state, which leaves transmitting as the only thing that stands out.
      return state.pttActive === true ? icons.micLive : icons.micOn;
    }

    return state.inputMuted ? icons.micOff : icons.micOn;
  }

  private updateAllIcons(): void {
    const icon = this.getIcon();
    for (const instance of this.actions) {
      if (instance.isKey()) void instance.setImage(icon);
    }
  }
}
```

- [ ] **Step 2: Build and run the whole suite**

`src/plugin.ts` needs no change — the class name and UUID are the same as before.

Run: `yarn build`
Expected: exit 0.

Run: `yarn test`
Expected: PASS, 50 tests.

- [ ] **Step 3: Commit**

```bash
git add src/actions/mute.ts
git commit -m "feat: one microphone key that toggles or holds by voice mode"
```

---

### Task 10: Verify against a running client

Nothing here is code. It is the check the unit tests cannot make, and it must be done before
this branch is considered finished.

**Files:** none.

**Interfaces:**
- Consumes: everything.
- Produces: a verified build.

- [ ] **Step 1: Build and install the plugin**

Run: `yarn build`
Then restart the plugin: `streamdeck restart com.alaydriem.bedrock-voice-chat.streamdeck`

- [ ] **Step 2: Confirm the no-key behaviour**

Clear the authentication key in the plugin settings. Expected: every key draws its
disconnected artwork, and
`com.alaydriem.bedrock-voice-chat.streamdeck.sdPlugin/logs/` contains "No authentication key
configured". Confirm the log does **not** fill with reconnect attempts.

- [ ] **Step 3: Confirm the existing keys still work**

Set the key to match the client's. Expected: Microphone, Deafen and Record all draw live state
and respond to presses. This is the regression that motivated the key fix.

Also confirm a profile saved before this change still shows its Mute key, now labelled
Microphone, rather than an empty slot. That is what keeping the UUID buys.

- [ ] **Step 4: Confirm the target dropdown**

Add a Connect key and open its Property Inspector. Expected: the dropdown lists saved proxies
and Realms under separate headings. Sign out of Xbox Live in the client and hit refresh —
expected: a single disabled entry carrying the client's own error text, not an empty list.

- [ ] **Step 5: Confirm connect, disconnect and switch**

With a target chosen: press once, expect the key to go live and a session to start in the app.
Press again, expect it to disconnect. Configure a second Connect key on a different world and
press it while the first is live — expect the session to switch and both keys to redraw.

- [ ] **Step 6: Confirm the icons follow the app**

With a session running from a Connect key, disconnect inside the BVC app itself. Expected: the
key returns to idle without being touched. This is the broadcast path.

- [ ] **Step 7: Confirm the microphone key switches behaviour with the mode**

With the client in open mic: expect a press to toggle mute, and the key to alternate between
`key-on` and the full-coral `key-off`.

Change the client to push-to-talk **without touching the Stream Deck**. Expected: the key
redraws itself to the resting artwork on its own, because the client broadcasts the mode
change. Now expect a press to transmit only while held, showing `key-live`, and a tap to do
nothing lasting.

Change back to open mic and confirm the key returns to toggling.

- [ ] **Step 8: Confirm the hot-mic guard**

In push-to-talk, hold the microphone key down and stop the BVC client mid-hold. Restart the
client. Expected: the microphone is not left open, and the plugin log shows a release sent on
reconnect. Repeat with a page change instead of a client stop — navigate away from the profile
while holding, and expect the same release.

- [ ] **Step 9: Report the colour treatment for review**

Screenshot the four keys in every state they can draw, including the microphone key in open
mic (unmuted, muted) and in push-to-talk (resting, transmitting). Two choices need a human
eye, and both were flagged rather than settled:

1. The dim `#4c293b` live ground against the fuller `#ff8266` the muted key uses.
2. Push-to-talk resting reusing `key-on`, which makes it identical to an unmuted open mic.

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: protocol types and frame
discrimination (1), request correlation (2), cycling and PI items (3), push-to-talk hold
tracking (4), press semantics (5), socket rewiring and the mandatory key (6), assets and
manifest (7), the Connect action and both Property Inspector pages (8), the mode-aware
microphone key (9), and manual verification (10). The spec's target-refresh policy is covered
across tasks 6 (open) and 8 (PI request, stale-list refetch).

**Type consistency.** `ConnectTarget`, `ActiveConnection`, `BvcCommand`, `BvcState`,
`BvcStateEvent` and `ConnectActionSettings` are all defined once in Task 1 and only read
afterwards. `wsManager.send` takes the options object from Task 6 in every call site (tasks 6,
8, 9). `pressTarget` is called with `wsManager` directly, which satisfies `ConnectTransport`
through the `activeConnection` getter added in Task 6. `icons` gains `micLive` in Task 7 and
it is read only in Task 9. `src/plugin.ts` reaches its final form in Task 8 and is not touched
afterwards, because Task 9 modifies an action that is already registered.

**Deliberate deviations, all recorded in the spec:** an unrecognised frame does not settle a
pending request; push-to-talk's resting state reuses `mute/key-on` rather than adding an
asset; and the microphone action keeps the `…streamdeck.mute` UUID despite its new name, so
saved profiles survive.
