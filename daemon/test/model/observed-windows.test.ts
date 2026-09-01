import { describe, expect, test } from "bun:test";
import { observedWindowsFromFrame } from "../../src/model/engine.ts";

describe("observedWindowsFromFrame", () => {
  test("reads a well-formed windows list", () => {
    const frame = { windows: [{ chromeWindowId: "CH-1", numericId: 42 }] };
    expect(observedWindowsFromFrame(frame)).toEqual([{ chromeWindowId: "CH-1", numericId: 42 }]);
  });

  test("drops malformed rows and keeps the good ones", () => {
    const frame = {
      windows: [
        { chromeWindowId: "CH-1", numericId: 42 },
        { chromeWindowId: 5, numericId: 42 },
        { chromeWindowId: "CH-2" },
        null,
        7,
      ],
    };
    expect(observedWindowsFromFrame(frame)).toEqual([{ chromeWindowId: "CH-1", numericId: 42 }]);
  });

  test("is empty for junk rather than throwing", () => {
    for (const junk of [null, undefined, 42, "text", [], {}, { windows: "no" }]) {
      expect(observedWindowsFromFrame(junk)).toEqual([]);
    }
  });
});
