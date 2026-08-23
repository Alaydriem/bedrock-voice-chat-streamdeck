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
  | { action: "jukebox" }
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
  jukeboxMuted: boolean | null;
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
  | { type: "jukeboxMuteChanged"; muted: boolean | null }
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

/**
 * Settings for the Stat action — one snapshot path.
 *
 * One stat to a key, so the number is legible across a room. Somebody who wants four watches
 * four keys, which also lets them arrange the four the way they want them.
 *
 * Only the path is stored. Unlike the Connect key, no label is cached beside it: labels come
 * from the plugin's own catalog, or are derived from the path, so a key reads correctly with
 * the client shut.
 */
export interface StatActionSettings {
  stat?: string;
  [key: string]: boolean | number | string | null | undefined;
}

/** Actions with nothing to configure: microphone, deafen, record. */
export type ActionSettings = Record<string, never>;
