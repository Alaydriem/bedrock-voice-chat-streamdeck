export type BvcCommand =
  | { action: "ping" }
  | { action: "mute"; device: "input" | "output" }
  | { action: "record" }
  | { action: "state" };

export interface BvcState {
  connected: boolean;
  inputMuted: boolean | null;
  outputMuted: boolean | null;
  recording: boolean | null;
}

export type BvcStateEvent =
  | { type: "connectionChanged"; connected: boolean }
  | { type: "inputMuteChanged"; muted: boolean | null }
  | { type: "outputMuteChanged"; muted: boolean | null }
  | { type: "recordingChanged"; recording: boolean | null };

export type GlobalSettings = {
  host?: string;
  port?: string;
  authenticationKey?: string;
  [key: string]: boolean | number | string | null | undefined;
};

export type ActionSettings = Record<string, never>;
