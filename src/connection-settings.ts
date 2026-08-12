import type { GlobalSettings } from "./types";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 9595;

/** Where the client is, and the key it demands. Shared by both sockets. */
export interface ConnectionSettings {
  host: string;
  port: number;
  key: string;
}

/** Parse a port string, returning the default if empty/invalid. */
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
