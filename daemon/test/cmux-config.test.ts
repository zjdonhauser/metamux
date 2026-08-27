import { describe, expect, test } from "bun:test";
import { extractNamedColorSlots, stripJsonComments, stripTrailingCommas } from "../src/cmux-config.ts";

describe("stripJsonComments", () => {
  test("strips a line comment", () => {
    expect(stripJsonComments('{"a": 1} // comment')).toBe('{"a": 1} ');
  });

  test("strips a full-line comment", () => {
    const input = '{\n  // this is a comment\n  "a": 1\n}';
    expect(stripJsonComments(input)).toBe('{\n  \n  "a": 1\n}');
  });

  test("does NOT strip // inside a string value", () => {
    expect(stripJsonComments('{"url": "https://example.com"}')).toBe('{"url": "https://example.com"}');
  });

  test("handles an escaped quote inside a string without breaking string tracking", () => {
    const input = String.raw`{"a": "he said \"hi // not a comment\""}`;
    expect(stripJsonComments(input)).toBe(input);
  });
});

describe("stripTrailingCommas", () => {
  test("removes a trailing comma before a closing brace", () => {
    expect(stripTrailingCommas('{"a": 1,\n}')).toBe('{"a": 1\n}');
  });

  test("removes a trailing comma before a closing bracket", () => {
    expect(stripTrailingCommas("[1, 2,\n]")).toBe("[1, 2\n]");
  });

  test("leaves a normal comma between properties untouched", () => {
    expect(stripTrailingCommas('{"a": 1, "b": 2}')).toBe('{"a": 1, "b": 2}');
  });
});

describe("extractNamedColorSlots", () => {
  test("extracts the workspaceColors.colors table from parsed JSON", () => {
    const parsed = { workspaceColors: { colors: { Blue: "#2779FB", Navy: "#152744" } } };
    expect(extractNamedColorSlots(parsed)).toEqual({ Blue: "#2779FB", Navy: "#152744" });
  });

  test("returns null when workspaceColors is missing", () => {
    expect(extractNamedColorSlots({})).toBeNull();
  });

  test("returns null when workspaceColors.colors is missing", () => {
    expect(extractNamedColorSlots({ workspaceColors: {} })).toBeNull();
  });

  test("ignores non-string values in the colors table", () => {
    const parsed = { workspaceColors: { colors: { Blue: "#2779FB", Bogus: 42 } } };
    expect(extractNamedColorSlots(parsed)).toEqual({ Blue: "#2779FB" });
  });

  test("returns null for non-object input", () => {
    expect(extractNamedColorSlots(null)).toBeNull();
    expect(extractNamedColorSlots("not an object")).toBeNull();
  });
});
