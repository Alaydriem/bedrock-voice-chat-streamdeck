# Connect targets and a mode-aware microphone key

Date: 2026-08-09
Status: approved, not yet implemented

## Why

The BVC client (`feat/radial-login`, `common/websocket-types` + `client/src-tauri/src/websocket`)
added four commands to the command socket: `targets`, `connect`, `disconnect`, and `ptt`. It
also made two changes that break this plugin as it stands.

This work makes the plugin whole against that client: a key that toggles a Realm or proxy, a
microphone key that toggles or holds depending on the client's voice mode, and the two fixes.

## What the client offers

Everything rides the existing command socket. No new path, no new handshake, no change to
reconnect or keepalive.

| Command | Request | Success `data` |
| --- | --- | --- |
| `targets` | `{"action":"targets","key":K}` | `{"targets":[{"id","name","kind"}]}` |
| `connect` | `{"action":"connect","id":ID,"key":K}` | `{"connected":true,"id","name"}` |
| `disconnect` | `{"action":"disconnect","key":K}` | `{"connected":false,"id","name"}` |
| `ptt` | `{"action":"ptt","down":B,"key":K}` | `{"active":B}` |
| `state` | `{"action":"state","key":K}` | see below |

`state` data, all fields snake_case on the wire:

```json
{
  "muted": false, "deafened": false, "recording": false,
  "voice_mode": "openMic" | "pushToTalk",
  "ptt_active": false,
  "connection": null | { "id": "...", "name": "...", "kind": "proxy" | "realm" }
}
```

Errors are `{"success":false,"error":"..."}` and are never broadcast — only ever a direct
response. This is load-bearing for request correlation below.

### Facts the design leans on

1. **`connection` rides every state frame.** `start_proxy`, `start_realm`, `stop_proxy` and
   `stop_realm` each call `broadcast_state` (`connector/mod.rs:163,246,268,287`). A user who
   connects or disconnects inside the app pushes a frame to the plugin. The keys never poll.
2. **Target ids are opaque.** `{source}:{native}` — `saved:<uuid>`, `server:<host>:<port>`,
   `realm:<numeric>` (`connect_target_id.rs`). The plugin stores and quotes them back
   verbatim. It never parses them and never matches a target by list position.
3. **The client answers in order.** `serve_commands` reads one frame, awaits the command, and
   writes the response before reading again. Two frames sent back to back are processed in
   order, so a `disconnect` followed immediately by a `connect` cannot interleave.
4. **One session at a time.** `start_proxy` and `start_realm` each refuse while the other runs.
5. **`targets` is all-or-nothing** and needs Xbox Live sign-in; otherwise it errors rather
   than returning a partial list (`target/mod.rs:126`).
6. **`disconnect` names no target and is idempotent.** `id` and `name` are `null` when
   nothing was running.
7. **`PttHold` is an `AtomicBool`, not a refcount**, and both edges are idempotent — a press
   while held and a release with nothing behind it are both no-ops. Unpaired frames cannot
   corrupt it. A 300 ms `PTT_TAIL` keeps a release from clipping speech.

### The two breaks

- **The auth key is mandatory.** `websocket/mod.rs:411` is
  `if auth_key.is_empty() || parsed.key != Some(key)`. The plugin omits `key` when unset
  (`ws-manager.ts:102`) and the PI calls it "Optional", so mute, deafen and record all fail
  against the new client.
- **Input mute is refused in push-to-talk.** `VoiceModeGuard` returns an error where the old
  client silently absorbed it, so the Mute key alerts on every press in that mode.

## Design

### Module layout

Existing files keep their jobs. `ws-manager.ts` stays transport plus state mirror; the logic
that is easy to get wrong is extracted so it can be tested without a socket or an SDK.

```
src/
  types.ts               extended: commands, state, events, per-action settings
  icons.ts               extended
  plugin.ts              registers four actions
  frame.ts               NEW  pure: raw text -> discriminated frame
  pending-requests.ts    NEW  pure: FIFO request/response correlation
  connect-controller.ts  NEW  press semantics for the connect key
  ptt-holds.ts           NEW  pure: which instances are held, and when to release
  target-items.ts        NEW  pure: targets -> grouped Property Inspector items
  ws-manager.ts          transport, state mirror, target cache
  actions/
    mute.ts              one mic key: toggle in open mic, hold in push-to-talk
    deafen.ts            unchanged
    record.ts            unchanged
    connect.ts           NEW  fixed target
tests/
  frame.test.ts
  pending-requests.test.ts
  connect-controller.test.ts
  ptt-holds.test.ts
vitest.config.ts
```

### Types

```ts
export type ConnectTargetKind = "proxy" | "realm";
export type VoiceMode = "openMic" | "pushToTalk";

export interface ConnectTarget { id: string; name: string; kind: ConnectTargetKind }
export interface ActiveConnection { id: string; name: string; kind: ConnectTargetKind }

export type BvcCommand =
  | { action: "ping" }
  | { action: "mute"; device: "input" | "output" }
  | { action: "record" }
  | { action: "state" }
  | { action: "ptt"; down: boolean }
  | { action: "targets" }
  | { action: "connect"; id: string }
  | { action: "disconnect" };

export interface BvcState {
  connected: boolean;                     // the websocket, not the game session
  inputMuted: boolean | null;
  outputMuted: boolean | null;
  recording: boolean | null;
  voiceMode: VoiceMode | null;
  pttActive: boolean | null;
  connection: ActiveConnection | null;    // the game session; null also means "socket down"
  targets: readonly ConnectTarget[];
}
```

`null` keeps its existing meaning of "not known", disambiguated by `state.connected` exactly
as the current actions already do for `inputMuted`.

Per-action settings:

```ts
export interface ConnectActionSettings {
  targetId?: string;
  targetName?: string;      // cached so the key still reads correctly with the socket down
  targetKind?: ConnectTargetKind;
}
export type ActionSettings = Record<string, never>;   // microphone, deafen, record
```

Events gain `voiceModeChanged`, `pttActiveChanged`, `activeConnectionChanged` and
`targetsChanged`, alongside the four that exist.

### Frame discrimination — `frame.ts`

`ResponseData` is an untagged enum on the Rust side, so the plugin discriminates by field
presence. Order matters; this order has no collisions against the current payloads.

```
1.  not an object                                          -> unknown
2.  success === false                                      -> error(message)
3.  no data                                                -> unknown
4.  data.pong === true                                     -> pong
5.  Array.isArray(data.targets)                            -> targets
6.  typeof data.device === "string" && muted is boolean    -> mute
7.  muted, deafened and recording all boolean              -> state
8.  typeof data.connected === "boolean"                    -> connect
9.  typeof data.recording === "boolean"                    -> record
10. typeof data.active === "boolean"                       -> ptt
11. otherwise                                              -> unknown
```

Unknown frames are logged and ignored, so a future command cannot crash the plugin.

### Request correlation — `pending-requests.ts`

The current single `pendingErrorCallback` (`ws-manager.ts:105`) holds one in-flight request.
The PI fetching `targets` while a key is pressed misattributes the alert. It is replaced by a
FIFO, which is correct because of fact 3 above.

The one ambiguity is that a broadcast state frame is shape-identical to a `state` response.
It is resolved by never enqueuing the two commands whose responses are ambiguous:

- `ping` and `state` are sent without a queue entry.
- Every other command pushes an entry.
- An **error** frame shifts the head and calls its `onError`.
- A **state**, **pong** or **unrecognised** frame never touches the queue. State and pong are
  ambiguous with broadcasts; an unrecognised frame might be a broadcast the plugin does not
  parse, and shifting on one would desynchronise the queue permanently. Leaving it alone costs
  at most one entry, which the timeout below reclaims.
- Any **other** frame shifts the head, and delivers `onTargets` when the entry asked for it.

Entries carry `REQUEST_TIMEOUT_MS = 10_000`. On timeout the entry is marked abandoned rather
than removed: its callbacks stop firing, but it stays in place and still consumes its response
slot, so a late reply cannot shift the queue out of alignment. The queue is capped at
`MAX_PENDING = 16` as a backstop; tripping it means the client has stopped answering and
alignment is already lost, so the whole queue is cleared and every entry errors. An empty
queue is by definition aligned.

Socket close abandons every entry with an error, so no PI dropdown hangs on a dead socket.

### Press semantics — `connect-controller.ts`

One place owns what a press means. It takes a transport interface rather than importing the
`wsManager` singleton, so the decision is testable without a socket.

```
press(targetId):
  live = state.connection
  live?.id === targetId  ->  send disconnect
  live                   ->  send disconnect, then send connect(targetId)   // switch
  otherwise              ->  send connect(targetId)
```

The switch sends both frames back to back without waiting, which fact 3 makes safe. Each
frame carries its own error callback, so a failing `disconnect` and a failing `connect` each
raise their own alert.

Nothing is drawn optimistically. Icons come only from the state frame the client broadcasts
afterwards, so a press that fails leaves the key showing what is actually true.

A `connect` that fails with a message naming an unknown id triggers exactly one `targets`
refetch — the stale-list case is the only one where a retry helps.

### Target cache

`wsManager.targets`, refreshed on three events and never on a timer:

- socket open, after the initial `state`
- a Property Inspector `getTargets` request (always refetched, `isRefresh` ignored)
- once after a `connect` rejected for an unknown id

Realms come over the network on the client side, so a timer would be a repeated round trip
for a list that changes when the user edits it and at no other time.

### Actions

**Connect** — `…streamdeck.connect`. Bound to one target chosen in its Property Inspector.
Press runs `connect-controller.press(targetId)`. Title is the cached target name.

States: connected-to-this-target, idle, disconnected. Disconnected covers a dead socket, an
unset auth key, and an unconfigured target — in each case the key cannot do its job, and the
distinction is in the log rather than on the key.

There is deliberately no key that cycles through the target list. It would set its title to
the selected world, so the name is legible, but the interaction is still worse than what the
Connect key already gives: one key per world, each carrying its own name and picked from a
dropdown that shows the whole list at once. Cycling asks the user to step blind through a list
of unknown length to reach the world they already know they want.

**Microphone** — keeps the existing `…streamdeck.mute` UUID so profiles that already carry a
Mute key keep working; only its `Name` and `Tooltip` change. One key, two behaviours, chosen
by `voice_mode` from the last state frame:

- `openMic` — press toggles input mute, release ignored. Exactly what the key does today.
- `pushToTalk` — press sends `{"action":"ptt","down":true}`, release sends `down:false`.

This is one control, not two. The client says so itself: `voice_mode` exists "to decide what
the mute control means … a toggle there would be a second word for a state the hold already
owns". Splitting it into a Mute key and a PTT key would ship two keys that are each dead half
the time, since `VoiceModeGuard` refuses input mute in `pushToTalk` and refuses `ptt` in
`openMic`. A press in a mode the plugin has not learned yet (`voiceMode === null`, meaning no
state frame has arrived) alerts without sending.

The hot-mic hazard is the plugin's to close, and it belongs to this key. The client
deliberately does not release on a dropped connection and `PttHold` has no watchdog, so a
socket death mid-hold leaves the microphone open.

`ptt-holds.ts` owns that bookkeeping, separately from the action so it can be tested without
the SDK. It holds the set of action instance ids currently down, and answers one question —
given an event, does a release need to be sent? It returns yes on:

- `keyUp` for an instance that was down
- `disappear` for an instance that was down
- `socketOpen`, once, when any instance was down at the moment the socket died

A socket close clears the set, because nothing can be sent over a dead socket; the pending
release is what survives, and it fires on the next open.

**Deafen, Record** — unchanged. Output mute is allowed in both voice modes, so Deafen needs no
mode awareness.

### Property Inspector

`ui/connect.html`, set as `PropertyInspectorPath` on the Connect action only. A per-action PI
replaces the global one, so this page repeats the host, port and key fields — they are
`global` settings and bind identically from any page.

The dropdown uses the sdpi-components datasource protocol. The PI sends
`{"event":"getTargets","isRefresh":…}` via `sendToPlugin`; the plugin issues a `targets`
command and replies through `sendToPropertyInspector` with `{"event":"getTargets","items":[…]}`.

Items are grouped by `kind`, empty groups omitted:

```json
[
  { "label": "Proxies", "children": [ { "label": "My Server", "value": "saved:abc" } ] },
  { "label": "Realms",  "children": [ { "label": "My Realm",  "value": "realm:12345" } ] }
]
```

When `targets` errors — no Xbox sign-in being the common case — the dropdown shows the
client's own error text as a single disabled item rather than an empty list.

The global PI relabels the key field from "Optional" to "Required".

An unset key means the client refuses every command, including `ping`, which would leave the
keepalive timing out and the socket reconnecting forever. So the plugin does not open a socket
at all without a key: it logs why once, leaves `state.connected` false, and every key draws
disconnected. Setting a key already triggers a reconnect through the existing settings
listener.

### Assets

One new folder `imgs/actions/connect/`, plus one new file
`imgs/actions/mute/key-live.svg` for the microphone key while transmitting.

The microphone key draws five situations from three existing assets and that one new one:

| Mode | State | Art |
| --- | --- | --- |
| `openMic` | unmuted | `key-on` |
| `openMic` | muted | `key-off` |
| `pushToTalk` | resting | `key-on` |
| `pushToTalk` | transmitting | `key-live` (new) |
| either | socket down, no key, or mode not yet known | `key-disconnected` |

Reusing `key-on` for push-to-talk's resting state makes "unmuted in open mic" and "ready in
push-to-talk" look the same. Both mean the microphone is in its normal state, and it leaves
transmitting as the only thing that pops — worth confirming on hardware.

Each follows the existing recipe exactly: 144×144,
`#19102f` ground, `#d6cbea` stroke at 1.9, glyph translated to `(38,38)` and scaled 2.875,
unavailable states at `opacity 0.4` with a slash, and `icon.svg` as the 20×20 list variant in
`#fbf8ff`.

The existing assets use two different active treatments and the distinction is meaningful:
`record/key-on` is a dim `#4c293b` ground with a `#ff8266` stroke, while `mute/key-off` is a
full `#ff8266` ground with a `#1c1132` stroke. The first reads as "running normally", the
second as "attention". Connected and transmitting are both the former, so Connect
and `mute/key-live` both take the dim `#4c293b` treatment. The full coral ground stays
reserved for the muted key, which is the one state that wants to be noticed.

### Manifest

One action appended, `Keypad`, with `ShowTitle: true` because the target name is what tells
one Connect key from another. It is the only action with a `PropertyInspectorPath`.

The existing Mute entry keeps its UUID and artwork and changes only its `Name` to
"Microphone" and its `Tooltip` to describe both behaviours. Changing the UUID would silently
drop the key from every profile that already has one.

## Testing

Vitest, unit tests only, in `tests/`. The SDK and socket edges stay untested; everything below
is pure and reachable without either.

- **`frame.ts`** — one case per branch, plus the shapes that could collide: a `mute` response
  against a `state` frame, a `connect` response against a `record` response, a state frame
  carrying `connection` against one carrying `null`.
- **`pending-requests.ts`** — an error shifts the head; a broadcast state frame arriving
  between a request and its response does not; a targets frame delivers to the right entry;
  a timed-out entry stops calling back but still consumes its slot; close abandons everything.
- **`connect-controller.ts`** — all three branches, and that the switch emits `disconnect`
  before `connect`.
- **`ptt-holds.ts`** — release on key up, release on disappear while held, release once and
  only once on reopen after a drop, and no release on reopen when nothing was held.

Manual verification against a running client covers what the unit tests cannot: the PI
dropdown populating, the icons following a connect made inside the app, and a real hold
opening and closing the microphone.

## Out of scope

- The `/metrics` route. Push-only diagnostics, unrelated to these keys.
- Dial and touch controllers. Every action here is `Keypad`, matching the existing three.
- Wiring vitest into the release workflow. Tests are runnable but do not gate a release.
