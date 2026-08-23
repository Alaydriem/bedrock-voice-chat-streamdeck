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
