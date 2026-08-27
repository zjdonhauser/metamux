import { describe, expect, test } from "bun:test";
import { buildSpawnArgs, isSafeSessionName } from "../src/cmux-actuator.ts";

describe("isSafeSessionName", () => {
  test("accepts plain alnum/dash/underscore/space names", () => {
    expect(isSafeSessionName("compliance")).toBe(true);
    expect(isSafeSessionName("mh-accounts")).toBe(true);
    expect(isSafeSessionName("Terminal 1")).toBe(true);
    expect(isSafeSessionName("oprey_ingest")).toBe(true);
  });

  test("rejects shell-meaningful characters (plan §1.10/§4 finding)", () => {
    for (const unsafe of ["foo; rm -rf ~", "foo$(whoami)", "foo`whoami`", 'foo"bar', "foo'bar", "foo|bar", "foo&bar"]) {
      expect(isSafeSessionName(unsafe)).toBe(false);
    }
  });

  test("rejects an empty name", () => {
    expect(isSafeSessionName("")).toBe(false);
  });
});

describe("buildSpawnArgs", () => {
  test("windows mode includes --window", () => {
    const args = buildSpawnArgs({ windowId: "win-1", sessionName: "compliance", cwd: "/Users/zac/Documents/GitHub" });
    expect(args).toEqual([
      "new-workspace",
      "--name",
      "compliance",
      "--cwd",
      "/Users/zac/Documents/GitHub",
      "--focus",
      "false",
      "--command",
      "tmux new -A -s compliance",
      "--window",
      "win-1",
    ]);
  });

  test("global mode (windowId null) omits --window", () => {
    const args = buildSpawnArgs({ windowId: null, sessionName: "wakey", cwd: "/hub" });
    expect(args).not.toContain("--window");
    expect(args).toEqual(["new-workspace", "--name", "wakey", "--cwd", "/hub", "--focus", "false", "--command", "tmux new -A -s wakey"]);
  });

  test("returns null for an unsafe session name rather than building an unsafe command", () => {
    expect(buildSpawnArgs({ windowId: "win-1", sessionName: "foo; rm -rf ~", cwd: "/hub" })).toBeNull();
  });
});
