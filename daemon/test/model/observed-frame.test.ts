import { describe, expect, test } from "bun:test";
import { observedFromFrame } from "../../src/model/engine.ts";

const tab = { tabId: 1, url: "https://example.com" };

describe("observedFromFrame", () => {
  test("accepts a well-formed frame", () => {
    const frame = { groups: [{ groupId: 10, label: "alpha", chromeWindowId: "CH-1", tabs: [tab] }] };
    expect(observedFromFrame(frame)).toEqual({
      groups: [{ groupId: 10, label: "alpha", chromeWindowId: "CH-1", tabs: [tab] }],
    });
  });

  // A group in an unmarked window is kept, not dropped: that state is exactly
  // what should produce a move toward the paired window.
  test("keeps a group whose window has no marker", () => {
    const frame = { groups: [{ groupId: 10, label: "alpha", chromeWindowId: null, tabs: [tab] }] };
    expect(observedFromFrame(frame).groups[0].chromeWindowId).toBeNull();
  });

  // One malformed group must not stop the daemon reconciling the rest.
  test("drops malformed groups and keeps the good ones", () => {
    const frame = {
      groups: [
        { groupId: 10, label: "alpha", chromeWindowId: "CH-1", tabs: [tab] },
        { groupId: "ten", label: "bad" },
        { label: "no id" },
        null,
        42,
      ],
    };
    expect(observedFromFrame(frame).groups).toHaveLength(1);
  });

  test("drops malformed tabs within a good group", () => {
    const frame = {
      groups: [{ groupId: 10, label: "alpha", chromeWindowId: "CH-1", tabs: [tab, { tabId: "x" }, null, { url: 5 }] }],
    };
    expect(observedFromFrame(frame).groups[0].tabs).toEqual([tab]);
  });

  test("treats a missing tabs array as no tabs", () => {
    const frame = { groups: [{ groupId: 10, label: "alpha", chromeWindowId: "CH-1" }] };
    expect(observedFromFrame(frame).groups[0].tabs).toEqual([]);
  });

  test("is empty for junk rather than throwing", () => {
    for (const junk of [null, undefined, 42, "text", [], {}, { groups: "no" }]) {
      expect(observedFromFrame(junk)).toEqual({ groups: [] });
    }
  });
});
