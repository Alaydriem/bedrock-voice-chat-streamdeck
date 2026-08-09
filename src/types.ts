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

/** Actions with nothing to configure: microphone, deafen, record. */
export type ActionSettings = Record<string, never>;
