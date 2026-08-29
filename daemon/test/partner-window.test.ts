import { describe, expect, test } from "bun:test";
import { decideAutoCreate, decidePartnerClose, type AutoCreateInput } from "../src/partner-window.ts";

const base: AutoCreateInput = {
  enabled: true,
  pairingHealthy: true,
  displaysNeedingPartner: [1],
  lastCreateAtByDisplay: new Map(),
  now: 100_000,
};

describe("decideAutoCreate", () => {
  test("creates a partner for a display that has cmux but no Chrome", () => {
    expect(decideAutoCreate(base)).toEqual({ kind: "create", displayId: 1 });
  });

  test("does nothing when disabled", () => {
    expect(decideAutoCreate({ ...base, enabled: false })).toBeNull();
  });

  // Creating a window is the most intrusive thing here, so an ambiguous frame
  // must never trigger one.
  test("does nothing while the invariant is violated", () => {
    expect(decideAutoCreate({ ...base, pairingHealthy: false })).toBeNull();
  });

  test("does nothing when every display already has a partner", () => {
    expect(decideAutoCreate({ ...base, displaysNeedingPartner: [] })).toBeNull();
  });

  test("rate-limits to one creation per display per 30s", () => {
    const recent = new Map([[1, 80_000]]);
    expect(decideAutoCreate({ ...base, lastCreateAtByDisplay: recent })).toBeNull();

    const old = new Map([[1, 60_000]]);
    expect(decideAutoCreate({ ...base, lastCreateAtByDisplay: old })).toEqual({
      kind: "create",
      displayId: 1,
    });
  });

  test("rate-limits per display, not globally", () => {
    const recent = new Map([[1, 80_000]]);
    expect(decideAutoCreate({ ...base, displaysNeedingPartner: [1, 2], lastCreateAtByDisplay: recent }))
      .toEqual({ kind: "create", displayId: 2 });
  });

  test("creates for one display at a time", () => {
    const d = decideAutoCreate({ ...base, displaysNeedingPartner: [1, 2, 3] });
    expect(d).toEqual({ kind: "create", displayId: 1 });
  });
});

describe("decidePartnerClose", () => {
  test("parks the paired window by default behavior", () => {
    expect(decidePartnerClose({ behavior: "park", chromeWindowId: 42 })).toEqual({
      kind: "park",
      chromeWindowId: 42,
    });
  });

  test("closes only when explicitly configured to", () => {
    expect(decidePartnerClose({ behavior: "close", chromeWindowId: 42 })).toEqual({
      kind: "close",
      chromeWindowId: 42,
    });
  });

  test("does nothing when off", () => {
    expect(decidePartnerClose({ behavior: "off", chromeWindowId: 42 })).toBeNull();
  });

  test("does nothing without a paired window to act on", () => {
    expect(decidePartnerClose({ behavior: "close", chromeWindowId: null })).toBeNull();
  });
});
