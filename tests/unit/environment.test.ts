import { describe, expect, it } from "vitest";
import {
  APPLICATION_RUNTIME_ENVIRONMENT_KEYS,
  isReservedApplicationEnvironmentKey,
  parseEnvironmentText,
} from "../../src/server/environment.ts";

describe("environment text parser", () => {
  it("accepts dotenv-style lines without exposing values later", () => {
    expect(
      parseEnvironmentText(`\uFEFF
# comment
DATABASE_URL=postgres://localhost/db
export API_TOKEN="line\\nvalue"
EMPTY=
SPACED = value with spaces # an unquoted comment
EQUALS=left=right
HASH="literal # hash" # a quoted comment
MULTILINE="first
second"
`),
    ).toEqual({
      DATABASE_URL: "postgres://localhost/db",
      API_TOKEN: "line\nvalue",
      EMPTY: "",
      SPACED: "value with spaces",
      EQUALS: "left=right",
      HASH: "literal # hash",
      MULTILINE: "first\nsecond",
    });
  });

  it("rejects malformed and duplicate keys", () => {
    expect(() => parseEnvironmentText("NOT A VARIABLE")).toThrow(/KEY=value/);
    expect(() => parseEnvironmentText("TOKEN=one\nTOKEN=two")).toThrow(/more than once/);
    expect(() => parseEnvironmentText("BAD-NAME=value")).toThrow(/invalid variable name/);
    expect(() => parseEnvironmentText('TOKEN="value" trailing')).toThrow(
      /unexpected text after a quoted value/,
    );
    expect(() => parseEnvironmentText('TOKEN="unterminated')).toThrow(/unterminated quoted value/);
  });

  it("identifies every runtime-owned and platform-owned variable as reserved", () => {
    for (const key of APPLICATION_RUNTIME_ENVIRONMENT_KEYS) {
      expect(isReservedApplicationEnvironmentKey(key)).toBe(true);
      expect(isReservedApplicationEnvironmentKey(key.toLowerCase())).toBe(true);
    }
    expect(isReservedApplicationEnvironmentKey("PLATFORM_MASTER_KEY")).toBe(true);
    expect(isReservedApplicationEnvironmentKey("platform_provider_token")).toBe(true);
    expect(isReservedApplicationEnvironmentKey("HOME")).toBe(false);
    expect(isReservedApplicationEnvironmentKey("PATH")).toBe(false);
    expect(isReservedApplicationEnvironmentKey("APP_SETTING")).toBe(false);
  });
});
