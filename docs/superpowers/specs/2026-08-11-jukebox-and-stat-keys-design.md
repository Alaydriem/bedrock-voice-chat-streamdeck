# A jukebox key and a live stat key

Date: 2026-08-11
Status: approved, not yet implemented

## Why

The BVC client (`feat/radial-login`, `common/websocket-types` + `client/src-tauri/src/websocket`)
added two things this plugin does not use yet:

1. A `jukebox` command that toggles whether jukebox music plays, with `jukebox_muted` on every
   state frame.
2. A second WebSocket route, `/metrics`, that pushes the whole diagnostics snapshot once per
   second.

This work adds two keys against them: a jukebox mute toggle, and a stat key that shows up to
four live numbers chosen from a dropdown.

## What the client offers

### Jukebox — the existing command socket

No new path, no new handshake, no change to reconnect or keepalive.

| Command | Request | Success `data` |
| --- | --- | --- |
| `jukebox` | `{"action":"jukebox","key":K}` | `{"muted":B}` |

`state` data gains one field, snake_case on the wire like the rest:

```json
{
  "muted": false, "deafened": false, "recording": false,
  "voice_mode": "openMic" | "pushToTalk",
  "ptt_active": false,
  "jukebox_muted": false,
  "connection": null | { "id": "...", "name": "...", "kind": "proxy" | "realm" }
}
```

Facts the design leans on:

1. **`jukebox` is a toggle, not a setter.** It matches `mute`: a key cannot read the current
   value before it is pressed.
2. **`jukebox` is state-changing.** It is in the `is_state_changing` set in `websocket/mod.rs`,
   so a toggle fans a full state frame to every other command client. Two Stream Decks stay in
   step, and so does the desktop UI.
3. **A jukebox reply is the barest `{muted}` shape on the socket.** A mute reply carries
   `device` beside it; a state frame carries `deafened` and `recording` beside it. Frame
   parsing must test the two richer shapes first.
4. **`muted` true means music is silenced.** The flag is a mute, not a play state.

### Stats — a second route, `/metrics`

```
ws://<host>:<port>/metrics?key=<authentication key>
```

Push-only. The key travels in the query string, because there is no inbound message to carry
one (`websocket/route/resolver.rs`). Two frame types arrive, each with its own `type`
discriminant:

```json
{ "type": "metrics", "data": { ...LinkDiagnosticsSnapshot } }
{ "type": "health",  "data": { "status": "Connected" } }
```

Facts the design leans on:

1. **Metrics push at 1 Hz** (`SNAPSHOT_INTERVAL`, `diagnostics/service/mod.rs:36`).
2. **Metrics stop entirely when the voice session is down.** `LinkDiagnosticsService::tick`
   returns `None` unless the session is connected, so a reconnecting, unauthorized or
   version-mismatched client pushes no snapshot at all. Silence is the normal failure signal,
   not an error.
3. **A health frame explains that silence.** `ConnectionHealth` is `#[serde(tag = "status")]`
   with `Connected`, `Reconnecting { attempt }`, `Disconnected`, `Failed`,
   `VersionMismatch { client_version, server_version, client_too_old }` and
   `Unauthorized { reason }`. One is sent immediately on upgrade, then on every transition.
4. **There is no command that lists the available stats.** The snapshot is the catalog. The
   plugin discovers what it can offer by walking a frame it has received.
5. **The snapshot is nested and contains arrays.** `mic`, `playback`, `link` and `session` are
   objects of scalars; `peers` and `history` are arrays.

## Design

### Module layout

Two new actions and five new modules, all small and each testable on its own:

```
src/actions/jukebox.ts    the toggle key
src/actions/stat.ts       the readout key
src/metrics-manager.ts    the /metrics socket, reference counted
src/metrics-frame.ts      raw text -> a metrics or health frame
src/stat-paths.ts         a snapshot -> selectable paths and values
src/stat-catalog.ts       labels, units and formatting for known paths
src/stat-view.ts          settings + snapshot + health -> what to draw
src/stat-image.ts         what to draw -> an SVG data URI
```

`ws-manager.ts` is not extended to own the second socket. It is already 485 lines, and a
push-only stream has none of its rules: no pending-request queue, no per-message key, no ping.
The two would share a class and nothing else.

## 1. The jukebox key

A sibling of the Deafen key, which is the closest existing template.

**Action** `com.alaydriem.bedrock-voice-chat.streamdeck.jukebox`. Keypad only. No Property
Inspector. `ShowTitle` false.

**Types** (`types.ts`):

- `BvcCommand` gains `{ action: "jukebox" }`.
- `BvcState` gains `jukeboxMuted: boolean | null`, `null` meaning not known.
- `BvcStateEvent` gains `{ type: "jukeboxMuteChanged"; muted: boolean | null }`.

**Frames** (`frame.ts`):

- `StateFrameData` gains `jukeboxMuted: boolean`, read as `data.jukebox_muted === true`. This
  mirrors how `ptt_active` is read, and it makes a client that predates the field read as
  "music plays" rather than as silenced.
- A new arm, `{ kind: "jukebox"; muted: boolean }`, placed **after** the `mute` and `state`
  arms for the reason in fact 3 above.

**State** (`ws-manager.ts`): one `setJukeboxMuted` beside the other setters, applied from both
the `jukebox` and `state` arms, and cleared to `null` in `clearReportedState`.

**Key behaviour**: a press sends `{ action: "jukebox" }` and shows an alert if the socket is
shut or the client refuses. The icon never changes on the press itself — it changes when the
resulting frame arrives, so the key shows what the client did rather than what was asked.

**Icons** (`imgs/actions/jukebox/`), matching the redesign set and its palette
(background `#19102f`, outline `#d6cbea`, alarm `#ff8266`):

| File | Drawn when |
| --- | --- |
| `key-on` | `jukeboxMuted === false` — music plays |
| `key-off` | `jukeboxMuted === true` — music silenced, filled alarm treatment like `mute/key-off` |
| `key-disconnected` | socket down, or `jukeboxMuted === null` |
| `key` | the manifest's static state image |
| `icon` | the action list |

## 2. The stat key

**Action** `com.alaydriem.bedrock-voice-chat.streamdeck.stat`. Keypad only.
`PropertyInspectorPath: "ui/stat.html"`. `ShowTitle` false — the image carries all the text.

A press does nothing. The key is a readout: no command is sent and no alert is raised.

### Settings

```ts
export interface StatActionSettings {
  stat1?: string;   // a dotted path, e.g. "link.rtt_ms"
  stat2?: string;
  stat3?: string;
  stat4?: string;
  [key: string]: boolean | number | string | null | undefined;
}
```

Only the path is stored. Unlike the Connect key, no label is cached alongside it: labels come
from the plugin's own catalog, or are derived from the path, so a key still reads correctly
with the client shut.

Empty and unset both mean "no stat in this slot". Slots are compacted before drawing, so a
user who fills slots 1 and 3 gets a two-stat layout rather than a gap.

### Property Inspector

`ui/stat.html` — four `sdpi-select` rows on the `getStats` datasource, plus the same global
host, port and key fields `connect.html` carries, so the pane is self-sufficient.

The plugin answers `getStats` from the last snapshot the metrics manager received, grouped by
section: Microphone, Playback, Link, Session. Every group is preceded by a "None" entry with an
empty value so a slot can be cleared.

With no snapshot yet — the client is shut, or the socket has only just opened — the datasource
returns one disabled entry, `Waiting for Bedrock Voice Chat`, the same shape the Connect key
uses for an empty target list. The refresh button refills it.

### The catalog

`stat-paths.ts` flattens a snapshot into ordered `{ path, value }` pairs:

- Objects recurse; the path is the dotted key trail.
- Arrays are skipped. `peers` and `history` are out of scope for this version. Per-speaker
  stats and RTT history need a different presentation from a single number on a key.
- Two paths are hidden: `captured_at_ms`, which the plugin uses for staleness rather than
  display, and `meter_events_per_sec`, which measures the client's own webview paint rate and
  means nothing on a controller.
- `null` values still yield a path. A stat that is not measured right now is still selectable,
  and draws as `—`.

`stat-catalog.ts` holds a table of short labels, units and rounding for the paths that exist
today. Six characters is roughly what a grid cell holds, so labels are terse:

| Path | Label | Unit | Rounding |
| --- | --- | --- | --- |
| `link.rtt_ms` | RTT | ms | 0 |
| `link.rtt_variance_ms` | JITTER | ms | 0 |
| `link.uplink_loss_pct` | UP LOSS | % | 1 |
| `link.downlink_loss_pct` | DN LOSS | % | 1 |
| `link.burst_loss_pct` | BURST | % | 1 |
| `link.worst_concealment_pct` | CONCEAL | % | 1 |
| `link.jitter_buffer_ms` | BUFFER | ms | 0 |
| `link.jitter_buffer_drops` | DROPS | — | count |
| `link.datagrams_dropped` | LOST | — | count |
| `link.uptime_secs` | UPTIME | — | duration |
| `link.paths_used` | PATHS | — | 0 |
| `link.quic_port` | PORT | — | plain |
| `link.family` | IP | — | text |
| `link.state` | LINK | — | text |
| `link.quality` | QUALITY | — | text |
| `link.stalled` | STALLED | — | YES / NO |
| `mic.capture_frames_per_sec` | CAPTURE | /s | 0 |
| `mic.datagrams_per_sec` | MIC TX | /s | 0 |
| `mic.noise_gate` | GATE | — | text |
| `mic.muted` | MIC | — | OFF / ON (muted is OFF) |
| `mic.sample_rate` | MIC HZ | kHz | 1, scaled by 1/1000 |
| `mic.device` | MIC DEV | — | text |
| `playback.datagrams_per_sec` | RX | /s | 0 |
| `playback.muted_peer_count` | MUTED | — | 0 |
| `playback.deafened` | DEAF | — | YES / NO |
| `playback.sample_rate` | OUT HZ | kHz | 1, scaled by 1/1000 |
| `playback.device` | OUT DEV | — | text |
| `session.server` | SERVER | — | text |
| `session.transport` | VIA | — | QUIC / WSS |
| `session.protocol_version` | PROTO | — | text |
| `session.proximity_range` | RANGE | m | 0 |
| `session.falloff` | FALLOFF | — | text |
| `session.family_preference` | IP PREF | — | text |

A path with no table entry is still offered. Its label is derived from the last path segment:
underscores to spaces, upper case, so a stat added to the client later appears as
`NEW COUNTER` without a plugin release. Its value is formatted by type — numbers to at most one
decimal, booleans as YES and NO, strings upper-cased.

Formatting rules that apply to every value:

- Counts of 10,000 and above shorten: `12.3k`, `1.2M`. A raw count overflows the cell.
- `plain` opts out of that shortening. A port is an identifier, not a quantity: `19132` must
  never render as `19.1k`.
- A `scaled by` entry divides before rounding, so a sample rate reported in Hz draws as
  `48.0 kHz` rather than as a five-digit number.
- A duration renders as `45s`, `12m`, or `1h02`.
- `null`, `undefined` and a path absent from the snapshot all render as `—`.
- A string longer than the cell is cut, with no ellipsis. An ellipsis costs a character and
  says nothing the cut does not.

### What is drawn

`stat-view.ts` is the decision logic, and the reason it is its own module is that all of it is
testable without Stream Deck or a socket:

```ts
statView(input: {
  paths: readonly string[];       // the compacted slots
  snapshot: Snapshot | null;
  ageMs: number | null;           // since the last metrics frame
  health: HealthState | null;     // the last health frame
  socketUp: boolean;              // the plugin's own /metrics socket
}): StatView
```

`StatView` is either `{ kind: "message"; text: string; tone: "normal" | "alarm" }` or
`{ kind: "cells"; cells: StatCell[] }`, where a cell is `{ label, value, unit }`.

The order of decisions, most severe first:

| Condition | Drawn |
| --- | --- |
| No slot configured | `NO STATS` |
| The plugin's `/metrics` socket is down | `NO CLIENT`, alarm |
| Health is `Unauthorized` | `AUTH`, alarm |
| Health is `VersionMismatch` | `VERSION`, alarm |
| Health is `Failed` | `FAILED`, alarm |
| Health is `Disconnected` | `OFFLINE` |
| Health is `Reconnecting` | `RETRY n` |
| No snapshot yet, or the last one is over 3 s old | cells with every value `—` |
| Otherwise | cells with values |

Rows not marked alarm carry the `normal` tone. `OFFLINE` and `RETRY n` are ordinary states of a
client that is working on it, and drawing them in the alarm colour would cry wolf during every
reconnect.

Three seconds is three missed pushes. Holding the last number past that would draw a dead link
as a healthy one, which is the failure this stream exists to report — the same reason the
client sends a health frame rather than a zero-filled snapshot.

### The image

`stat-image.ts` turns a `StatView` into `data:image/svg+xml;base64,…` for `setImage`. It is a
pure function: same view in, same string out.

The canvas is 144x144 with a `viewBox`, so the key is crisp at @2x and scales down cleanly.
Colours are the ones the redesign art already uses — background `#19102f`, values `#fbf8ff`,
labels `#d6cbea` at 60% opacity, alarm `#ff8266`. No new hexes enter the palette.

Layout follows the count:

```
1 stat            2 stats           3-4 stats
+------------+    +------------+    +-------+------+
|    RTT     |    |  RTT   42ms|    | RTT   | LOSS |
|            |    +------------+    | 42ms  | 0.4% |
|    42      |    | LOSS   0.4%|    +-------+------+
|     ms     |    |            |    | JIT   | CONC |
+------------+    +------------+    | 30ms  | 1.2% |
                                    +-------+------+
```

Three stats use the four-cell grid with the last cell empty. A message view draws its word
centred, across the whole key.

`font-family` is `Arial, Helvetica, sans-serif`. The Stream Deck app rasterises the SVG with
system fonts, and a named font absent on macOS would silently reflow the layout.

### Redrawing

The action keeps the last string it passed to `setImage` and skips the call when the new one is
identical. At 1 Hz, most fields do not change between frames, and a repaint that changes
nothing is work on the Stream Deck's own render path.

## 3. The metrics manager

`metrics-manager.ts` mirrors `ws-manager.ts` in shape — a single exported instance, a listener
set, an `initialize` that reads global settings — and differs in four ways.

**Reference counted.** `acquire()` on the first stat key's `onWillAppear` opens the socket;
`release()` on the last `onWillDisappear` closes it. A user with no stat key never opens a
second socket, and the client never pushes 1 Hz of diagnostics into a plugin that discards
them.

**Authenticated at the handshake.** The URL is
`ws://<host>:<port>/metrics?key=<encodeURIComponent(key)>`. Host, port and key come from the
same global settings `WsManager` reads, and a change to any of them tears the socket down and
reopens it, exactly as `WsManager` already does.

**No ping.** Nothing on this route reads inbound frames, so a plugin-level keepalive would be
answered by nothing. A dead socket is detected by `close` and `error` alone. Staleness of the
data is a separate matter and is handled by the watchdog below, because a silent socket is
normal whenever the voice session is down.

**A 1 Hz watchdog.** While subscribed, a timer emits a `staleChanged` event when the age of the
last snapshot crosses 3 s in either direction. Without it, a key that stops receiving frames
would keep drawing its last numbers forever: there is no frame to trigger a redraw.

Backoff is the same as `WsManager` — 1 s doubling to a 30 s ceiling, with the attempt count
reset after 30 s of a stable connection.

`metrics-frame.ts` parses one raw message into
`{ kind: "metrics"; data } | { kind: "health"; health } | { kind: "unknown" }`, switching on the
`type` discriminant. Unlike `frame.ts`, no shape guessing is needed: this route tags its
frames. An unknown `type` is ignored and logged once, so a frame added to the client later is
not an error.

## Error handling

| Situation | Behaviour |
| --- | --- |
| Jukebox pressed with the socket shut | `showAlert`, nothing sent |
| Jukebox refused by the client | `showAlert`, the client's message logged |
| No authentication key configured | Neither socket opens. `WsManager` already refuses, and the metrics route would be refused at the handshake |
| `/metrics` refused: wrong key | Logged with the reject reason; backoff continues. A wrong key is a settings mistake, and a key drawing `NO CLIENT` is the visible symptom |
| A malformed metrics frame | Ignored, logged; the previous snapshot stands and ages normally |
| A stat path missing from the snapshot | That cell draws `—`. The other cells are unaffected |
| The Property Inspector opened with no snapshot | One disabled entry naming the reason |

## Testing

Vitest, in the existing `tests/` mirror.

**`tests/stat-image.test.ts`** — one, two, three and four cells produce their layouts; a
message view centres its text; `—` renders for an absent value; the same view twice produces
byte-identical output, which is what the no-redraw check depends on.

**`tests/stat-paths.test.ts`** — a fixture snapshot flattens to the expected paths; `peers` and
`history` are absent; the two hidden paths are absent; a `null` field still yields a path.

**`tests/stat-catalog.test.ts`** — `link.rtt_ms` at 42 renders `42` and `ms`; a percentage
rounds to one decimal; 12,345 shortens to `12.3k`; 3,720 seconds renders `1h02`; an unknown
path derives its label from the last segment.

**`tests/stat-view.test.ts`** — the decision table above, row by row, including the ordering:
a socket that is down outranks a health frame that says `Connected`, and a stale snapshot draws
dashes rather than its last values.

**`tests/metrics-frame.test.ts`** — a metrics frame and a health frame are told apart by
`type`; every `ConnectionHealth` variant survives parsing, `Reconnecting` keeping its
`attempt`; an unknown `type` is `unknown` rather than a throw.

**`tests/metrics-manager.test.ts`** — against a fake socket: the first `acquire` opens and the
last `release` closes; two acquires need two releases; a settings change reopens; the watchdog
emits `staleChanged` on crossing 3 s and again on recovery.

**`tests/frame.test.ts`** — extended: a bare `{muted}` parses as `jukebox`, not as `mute` or
`state`; a mute reply and a state frame still parse as themselves; `jukebox_muted` is read from
a state frame, and its absence reads as `false`.

Not tested: the SVG's visual appearance, the manifest entries, and the Property Inspector HTML.

## Verification

- `yarn test`
- `yarn build`, then `streamdeck restart com.alaydriem.bedrock-voice-chat.streamdeck`
- By hand, against a running client: toggle the jukebox from the key and confirm the desktop UI
  follows; toggle it in the app and confirm the key follows.
- By hand: configure four stats, confirm they update once per second; shut the client and
  confirm the key reaches `NO CLIENT` rather than freezing on its last numbers.

## Risks

- **Four stats on 72 px.** A grid cell holds roughly six characters. The rounding and the
  shortening rules are what keep a value inside its cell; a stat that ignores them overruns
  into its neighbour.
- **Font availability.** The layout is positioned text, not paths. A system without the named
  family falls back to another, and metrics shift. The generic stack limits this, and short
  labels limit the damage.
- **The dropdown depends on a live client.** The catalog is discovered from a frame, so a user
  configuring keys with the client shut sees nothing to pick. This is the price of a list that
  stays honest to what the client actually reports, and it matches how the Connect key already
  behaves.
- **Two sockets to one client.** A user watching the client's connection pane now sees two
  rows for one Stream Deck, one `command` and one `metrics`. The client already labels them by
  route, so this is legible rather than confusing, but it is new.
