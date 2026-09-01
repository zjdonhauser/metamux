import { describe, expect, test } from "bun:test";
import { EMPTY, parseStore, parseStoreText, serializeStore, STORE_VERSION } from "../../src/model/store.ts";

const workspace = {
  id: "w1",
  sessionName: "alpha",
  label: "alpha",
  cmuxWindowId: "cw1",
  harness: { kind: "claude" as const, sessionId: null },
  archived: false,
};

describe("parseStore", () => {
  test("round-trips a valid store", () => {
    const state = { version: STORE_VERSION, workspaces: [workspace], pairs: [{ cmuxWindowId: "cw1", chromeWindowId: "CH1" }] };
    expect(parseStore(JSON.parse(serializeStore(state)))).toEqual(state);
  });

  // The no-migration rule, enforced in code rather than by intention: the old
  // registry held 116 rows for 7 real sessions.
  test("refuses the old registry format and starts empty", () => {
    const old = { workspaces: [{ id: "mw_x", title: "alpha", archived: false }], activeId: null };
    expect(parseStore(old)).toEqual(EMPTY);
  });

  test("starts empty on a version mismatch", () => {
    expect(parseStore({ version: 999, workspaces: [workspace], pairs: [] })).toEqual(EMPTY);
  });

  test("starts empty for junk", () => {
    for (const junk of [null, undefined, 42, "text", []]) {
      expect(parseStore(junk)).toEqual(EMPTY);
    }
  });

  // One bad row must not stop the daemon from starting.
  test("drops a malformed workspace and keeps the good ones", () => {
    const raw = { version: STORE_VERSION, workspaces: [workspace, { id: 5 }, null, { sessionName: "no id" }], pairs: [] };
    expect(parseStore(raw).workspaces).toEqual([workspace]);
  });

  test("drops a malformed pair and keeps the good ones", () => {
    const good = { cmuxWindowId: "cw1", chromeWindowId: "CH1" };
    const raw = { version: STORE_VERSION, workspaces: [], pairs: [good, { cmuxWindowId: "cw2" }, 7] };
    expect(parseStore(raw).pairs).toEqual([good]);
  });

  test("defaults a missing harness and cmuxWindowId to null", () => {
    const raw = { version: STORE_VERSION, workspaces: [{ id: "w", sessionName: "s", label: "s" }], pairs: [] };
    expect(parseStore(raw).workspaces[0]).toEqual({
      id: "w",
      sessionName: "s",
      label: "s",
      cmuxWindowId: null,
      harness: null,
      archived: false,
    });
  });

  test("rejects an unknown harness kind rather than storing it", () => {
    const raw = {
      version: STORE_VERSION,
      workspaces: [{ ...workspace, harness: { kind: "gemini", sessionId: "x" } }],
      pairs: [],
    };
    expect(parseStore(raw).workspaces[0].harness).toBeNull();
  });
});

describe("parseStoreText", () => {
  test("starts empty on unparseable text instead of throwing", () => {
    expect(parseStoreText("{not json")).toEqual(EMPTY);
    expect(parseStoreText("")).toEqual(EMPTY);
  });
});
