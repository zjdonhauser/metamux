import { describe, expect, test } from "bun:test";
import { WindowPairing } from "../src/window-pairing.ts";
import type { CGWindow, Display } from "../src/window-join.ts";

const PRIMARY: Display = { id: 0, bounds: { x: 0, y: 0, w: 2560, h: 1440 } };
const SECONDARY: Display = { id: 1, bounds: { x: -1539, y: -1080, w: 1920, h: 1080 } };
const SCREENS = [PRIMARY, SECONDARY];

const onPrimary: CGWindow[] = [
  { id: 100, owner: "cmux", bounds: { x: 0, y: 0, w: 1280, h: 1440 } },
  { id: 200, owner: "Google Chrome", bounds: { x: 1280, y: 0, w: 1280, h: 1440 } },
];
const onSecondary: CGWindow[] = [
  { id: 101, owner: "cmux", bounds: { x: -1539, y: -1080, w: 960, h: 1080 } },
  { id: 201, owner: "Google Chrome", bounds: { x: -579, y: -1080, w: 960, h: 1080 } },
];
const chromeReported = [
  { id: 42, bounds: { x: 1280, y: 0, w: 1280, h: 1440 } },
  { id: 43, bounds: { x: -579, y: -1080, w: 960, h: 1080 } },
];

describe("WindowPairing", () => {
  test("resolves a Chrome window for a cmux window seen on a display", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    p.noteActivation("CMUX-A");
    expect(p.chromeWindowFor("CMUX-A")).toBe(42);
  });

  test("keeps distinct bindings per display", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    p.noteActivation("CMUX-A");
    p.ingest(onSecondary, chromeReported, SCREENS);
    p.noteActivation("CMUX-B");

    expect(p.chromeWindowFor("CMUX-B")).toBe(43);
    // A is off-Space now. Derive when visible, REMEMBER when not.
    expect(p.chromeWindowFor("CMUX-A")).toBe(42);
  });

  test("re-verifies a remembered binding when the Space comes back", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    p.noteActivation("CMUX-A");
    p.ingest(onSecondary, chromeReported, SCREENS);

    // Chrome window on the primary got replaced while we were away.
    const movedChrome = [{ id: 77, bounds: { x: 1280, y: 0, w: 1280, h: 1440 } }, chromeReported[1]];
    p.ingest(onPrimary, movedChrome, SCREENS);
    expect(p.chromeWindowFor("CMUX-A")).toBe(77);
  });

  test("does not bind an activation while the invariant is violated", () => {
    const p = new WindowPairing();
    const twoChrome: CGWindow[] = [
      ...onPrimary,
      { id: 999, owner: "Google Chrome", bounds: { x: 40, y: 40, w: 900, h: 700 } },
    ];
    p.ingest(twoChrome, chromeReported, SCREENS);
    p.noteActivation("CMUX-A");

    expect(p.healthy).toBe(false);
    expect(p.chromeWindowFor("CMUX-A")).toBeNull();
  });

  test("a violation does not destroy a binding learned while healthy", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    p.noteActivation("CMUX-A");

    const twoChrome: CGWindow[] = [
      ...onPrimary,
      { id: 999, owner: "Google Chrome", bounds: { x: 40, y: 40, w: 900, h: 700 } },
    ];
    p.ingest(twoChrome, chromeReported, SCREENS);

    // Report unhealthy so callers fall back, but keep what we knew.
    expect(p.healthy).toBe(false);
    expect(p.rememberedDisplayFor("CMUX-A")).toBe(0);
  });

  test("ignores an activation when no cmux window is on screen", () => {
    const p = new WindowPairing();
    p.ingest([{ id: 200, owner: "Google Chrome", bounds: { x: 1280, y: 0, w: 1280, h: 1440 } }], chromeReported, SCREENS);
    p.noteActivation("CMUX-A");
    expect(p.chromeWindowFor("CMUX-A")).toBeNull();
  });

  test("rebinds when a cmux window moves to another display", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    p.noteActivation("CMUX-A");
    expect(p.chromeWindowFor("CMUX-A")).toBe(42);

    p.ingest(onSecondary, chromeReported, SCREENS);
    p.noteActivation("CMUX-A");
    expect(p.chromeWindowFor("CMUX-A")).toBe(43);
  });

  test("reports a stale snapshot as unhealthy", () => {
    const p = new WindowPairing({ staleAfterMs: 5000 });
    p.ingest(onPrimary, chromeReported, SCREENS, 1_000);
    expect(p.healthyAt(3_000)).toBe(true);
    expect(p.healthyAt(9_000)).toBe(false);
  });
});

describe("WindowPairing.displaysNeedingPartner", () => {
  const lone: CGWindow[] = [{ id: 300, owner: "cmux", bounds: { x: 0, y: 0, w: 1280, h: 1440 } }];

  test("reports a display with a terminal but no browser", () => {
    const p = new WindowPairing();
    p.ingest(lone, [], SCREENS);
    expect(p.displaysNeedingPartner()).toEqual([0]);
  });

  test("reports nothing when the display is already paired", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    expect(p.displaysNeedingPartner()).toEqual([]);
  });

  test("reports nothing for a browser with no terminal, which needs no partner", () => {
    const p = new WindowPairing();
    p.ingest([{ id: 301, owner: "Google Chrome", bounds: { x: 0, y: 0, w: 1280, h: 1440 } }], [], SCREENS);
    expect(p.displaysNeedingPartner()).toEqual([]);
  });

  test("reports nothing while unhealthy", () => {
    const p = new WindowPairing({ staleAfterMs: 5_000 });
    p.ingest(lone, [], SCREENS, 1_000);
    expect(p.displaysNeedingPartner(9_000)).toEqual([]);
  });
});

describe("WindowPairing.displaysThatLostTerminal", () => {
  // The event log carries no usable window-close signal, so a cmux window
  // going away is derived from consecutive snapshots instead.
  test("reports a display whose terminal disappeared", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    p.ingest([{ id: 200, owner: "Google Chrome", bounds: { x: 1280, y: 0, w: 1280, h: 1440 } }], chromeReported, SCREENS);
    expect(p.displaysThatLostTerminal()).toEqual([0]);
  });

  test("reports nothing while the terminal is still there", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    p.ingest(onPrimary, chromeReported, SCREENS);
    expect(p.displaysThatLostTerminal()).toEqual([]);
  });

  // Switching Spaces makes everything vanish at once. That is not a close, and
  // parking on it would hide the browser every time you switch desktops.
  test("reports nothing when the whole snapshot went empty", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    p.ingest([], chromeReported, SCREENS);
    expect(p.displaysThatLostTerminal()).toEqual([]);
  });

  test("reports nothing on the first snapshot", () => {
    const p = new WindowPairing();
    p.ingest(onPrimary, chromeReported, SCREENS);
    expect(p.displaysThatLostTerminal()).toEqual([]);
  });
});
