import { describe, expect, test } from "bun:test";
import { hostMap, listSessions, parseHostMapOutput, parseSessionsOutput, resolveMirrorMode } from "../src/tmux-source.ts";

const TAB = "\t";

describe("parseSessionsOutput", () => {
  test("parses id/name/attached rows", () => {
    const stdout = [`$25${TAB}cmux${TAB}3`, `$2${TAB}compliance${TAB}2`, `$36${TAB}wakey${TAB}0`].join("\n");
    expect(parseSessionsOutput(stdout)).toEqual([
      { id: "$25", name: "cmux", attached: 3 },
      { id: "$2", name: "compliance", attached: 2 },
      { id: "$36", name: "wakey", attached: 0 },
    ]);
  });

  test("returns [] for empty output", () => {
    expect(parseSessionsOutput("")).toEqual([]);
  });

  test("skips a malformed row (missing id or name)", () => {
    const stdout = [`$25${TAB}cmux${TAB}1`, `${TAB}${TAB}1`, `$2${TAB}compliance${TAB}1`].join("\n");
    expect(parseSessionsOutput(stdout)).toEqual([
      { id: "$25", name: "cmux", attached: 1 },
      { id: "$2", name: "compliance", attached: 1 },
    ]);
  });

  test("defaults attached to 0 when unparseable", () => {
    const stdout = `$9${TAB}mh-accounts${TAB}notanumber`;
    expect(parseSessionsOutput(stdout)).toEqual([{ id: "$9", name: "mh-accounts", attached: 0 }]);
  });
});

describe("parseHostMapOutput", () => {
  test("joins client pid -> session id -> CMUX_WORKSPACE_ID via ps eww", () => {
    const clients = [`3674${TAB}$25`, `3583${TAB}$2`].join("\n");
    const ps = [
      "3674 /bin/tmux attach -t cmux ANTHROPIC_API_KEY=redacted CMUX_WORKSPACE_ID=1D334484-F4CC-4088-B3F0-ADA3E1B955A1 PATH=/usr/bin",
      "3583 /bin/tmux attach -t compliance CMUX_WORKSPACE_ID=0CF5CF2D-FFB0-41ED-9735-A78A2AA28B79 PATH=/usr/bin",
    ].join("\n");
    const result = parseHostMapOutput(clients, ps);
    expect(result.get("1D334484-F4CC-4088-B3F0-ADA3E1B955A1")).toBe("$25");
    expect(result.get("0CF5CF2D-FFB0-41ED-9735-A78A2AA28B79")).toBe("$2");
    expect(result.size).toBe(2);
  });

  test("empty clients output produces an empty map without touching ps output", () => {
    expect(parseHostMapOutput("", "irrelevant CMUX_WORKSPACE_ID=abc").size).toBe(0);
  });

  test("a client with no matching ps line (process already exited) is silently dropped", () => {
    const clients = `9999${TAB}$25`;
    expect(parseHostMapOutput(clients, "").size).toBe(0);
  });

  test("a ps line with no CMUX_WORKSPACE_ID is ignored", () => {
    const clients = `3674${TAB}$25`;
    const ps = "3674 /bin/tmux attach -t cmux PATH=/usr/bin";
    expect(parseHostMapOutput(clients, ps).size).toBe(0);
  });
});

describe("resolveMirrorMode", () => {
  test("a recognized env override wins over the default", () => {
    expect(resolveMirrorMode("windows", { TMUX_CMUX_MIRROR: "global" })).toBe("global");
    expect(resolveMirrorMode("global", { TMUX_CMUX_MIRROR: "windows" })).toBe("windows");
  });

  test("falls back to the given default when unset", () => {
    expect(resolveMirrorMode("global", {})).toBe("global");
  });

  test("falls back to the given default for an unrecognized value", () => {
    expect(resolveMirrorMode("windows", { TMUX_CMUX_MIRROR: "bogus" })).toBe("windows");
  });

  test("defaults to windows with no default and no env given", () => {
    expect(resolveMirrorMode(undefined, {})).toBe("windows");
  });
});

// Live smoke tests: exercise the real subprocess path against whatever tmux
// this machine has (may or may not be running, may have no sessions). Only
// asserts the tolerant-of-anything contract these functions promise --
// never asserts specific session data, so this is safe in any environment.
describe("live tmux smoke (read-only, tolerant of tmux being absent)", () => {
  test("listSessions() returns an array and never throws", async () => {
    const sessions = await listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    for (const s of sessions) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.name).toBe("string");
      expect(typeof s.attached).toBe("number");
    }
  });

  test("hostMap() returns a Map and never throws", async () => {
    const map = await hostMap();
    expect(map instanceof Map).toBe(true);
  });
});
