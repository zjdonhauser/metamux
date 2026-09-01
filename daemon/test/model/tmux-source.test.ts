import { describe, expect, test } from "bun:test";
import { buildHookCommand, HOOK_EVENTS, parseSessionList } from "../../src/model/tmux-source.ts";

describe("parseSessionList", () => {
  test("reads name and stamped id", () => {
    expect(parseSessionList("alpha\tmw_abc123\n")).toEqual([{ name: "alpha", metamuxId: "mw_abc123" }]);
  });

  // tmux renders an unset user option as an empty field, so this is what every
  // session looks like right after a tmux server restart.
  test("treats an empty id field as never stamped", () => {
    expect(parseSessionList("beta\t\n")).toEqual([{ name: "beta", metamuxId: null }]);
  });

  test("reads a mixed list", () => {
    expect(parseSessionList("alpha\tmw_1\nbeta\t\ngamma\tmw_3\n")).toEqual([
      { name: "alpha", metamuxId: "mw_1" },
      { name: "beta", metamuxId: null },
      { name: "gamma", metamuxId: "mw_3" },
    ]);
  });

  // Splitting on the last tab keeps a tab inside a session name from eating
  // the id field.
  test("a tab inside a session name does not eat the id", () => {
    expect(parseSessionList("odd\tname\tmw_9\n")).toEqual([{ name: "odd\tname", metamuxId: "mw_9" }]);
  });

  test("is empty for no output", () => {
    expect(parseSessionList("")).toEqual([]);
  });
});

describe("buildHookCommand", () => {
  test("builds a global hook that nudges the daemon", () => {
    expect(buildHookCommand("session-created", "http://127.0.0.1:8377/tmux-changed")).toEqual([
      "set-hook",
      "-g",
      "session-created",
      'run-shell "curl -s -m 1 -X POST http://127.0.0.1:8377/tmux-changed >/dev/null 2>&1 || true"',
    ]);
  });

  // A hook that fails must never break the tmux command that triggered it, and
  // must never hang a session on a dead daemon.
  test("the hook cannot fail or hang the tmux action that fired it", () => {
    const cmd = buildHookCommand("session-closed", "http://127.0.0.1:8377/tmux-changed")[3];
    expect(cmd).toContain("-m 1");
    expect(cmd).toContain("|| true");
  });

  test("covers create, rename and close", () => {
    expect(HOOK_EVENTS).toEqual(["session-created", "session-renamed", "session-closed"]);
  });
});
