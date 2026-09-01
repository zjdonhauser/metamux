import { describe, expect, test } from "bun:test";
import { buildObservation, markerIdFromUrl, numericWindowFor } from "../observe.js";

const PANEL = "chrome-extension://abc123/panel.html";
const win = (id, type = "normal") => ({ id, type });
const marker = (windowId, minted) => ({ windowId, url: `${PANEL}?win=${minted}` });
const group = (groupId, title, windowId, tabs = [{ tabId: 1, url: "https://x" }]) => ({ groupId, title, windowId, tabs });

describe("markerIdFromUrl", () => {
  test("reads the minted id", () => {
    expect(markerIdFromUrl(`${PANEL}?win=CH-1`, PANEL)).toBe("CH-1");
  });

  test("decodes a percent-encoded id", () => {
    expect(markerIdFromUrl(`${PANEL}?win=a%2Fb`, PANEL)).toBe("a/b");
  });

  test("returns null for the bare panel with no id", () => {
    expect(markerIdFromUrl(PANEL, PANEL)).toBeNull();
    expect(markerIdFromUrl(`${PANEL}?win=`, PANEL)).toBeNull();
  });

  test("returns null for any other url", () => {
    expect(markerIdFromUrl("https://example.com?win=CH-1", PANEL)).toBeNull();
    expect(markerIdFromUrl(undefined, PANEL)).toBeNull();
  });
});

describe("buildObservation", () => {
  test("keys a group by its window's minted id", () => {
    const obs = buildObservation([win(1)], [marker(1, "CH-1")], [group(10, "alpha", 1)], PANEL);
    expect(obs.groups).toEqual([{ groupId: 10, label: "alpha", chromeWindowId: "CH-1", tabs: [{ tabId: 1, url: "https://x" }] }]);
    expect(obs.windows).toEqual([{ chromeWindowId: "CH-1", numericId: 1 }]);
  });

  // Never hand the daemon an ephemeral numeric id. Null is the honest answer
  // for a window that is not paired yet.
  test("reports null, not a numeric id, for a group in an unmarked window", () => {
    const obs = buildObservation([win(1)], [], [group(10, "alpha", 1)], PANEL);
    expect(obs.groups[0].chromeWindowId).toBeNull();
    expect(obs.unmarkedWindowIds).toEqual([1]);
  });

  test("separates marked from unmarked windows", () => {
    const obs = buildObservation([win(1), win(2)], [marker(1, "CH-1")], [], PANEL);
    expect(obs.windows).toEqual([{ chromeWindowId: "CH-1", numericId: 1 }]);
    expect(obs.unmarkedWindowIds).toEqual([2]);
  });

  // Chrome refuses group moves into popup and app windows, so they are not
  // candidates and must not appear as pairable.
  test("ignores windows that are not normal", () => {
    const obs = buildObservation([win(1), win(2, "popup")], [marker(1, "CH-1")], [], PANEL);
    expect(obs.windows).toHaveLength(1);
    expect(obs.unmarkedWindowIds).toEqual([]);
  });

  // A duplicated marker must not flip a window's identity between passes.
  test("first marker wins when a window somehow has two", () => {
    const obs = buildObservation([win(1)], [marker(1, "CH-1"), marker(1, "CH-2")], [group(10, "alpha", 1)], PANEL);
    expect(obs.groups[0].chromeWindowId).toBe("CH-1");
  });

  test("handles several windows each with their own groups", () => {
    const obs = buildObservation(
      [win(1), win(2)],
      [marker(1, "CH-1"), marker(2, "CH-2")],
      [group(10, "alpha", 1), group(11, "beta", 2)],
      PANEL,
    );
    expect(obs.groups.map((g) => g.chromeWindowId)).toEqual(["CH-1", "CH-2"]);
  });

  test("is empty for an empty browser", () => {
    expect(buildObservation([], [], [], PANEL)).toEqual({ windows: [], groups: [], unmarkedWindowIds: [] });
  });
});

describe("numericWindowFor", () => {
  test("maps a minted id back to the id Chrome ops need", () => {
    const obs = buildObservation([win(7)], [marker(7, "CH-1")], [], PANEL);
    expect(numericWindowFor(obs, "CH-1")).toBe(7);
  });

  test("returns null for a minted id no live window carries", () => {
    const obs = buildObservation([win(7)], [marker(7, "CH-1")], [], PANEL);
    expect(numericWindowFor(obs, "CH-gone")).toBeNull();
  });
});
