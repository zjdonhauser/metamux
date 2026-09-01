import { describe, expect, test } from "bun:test";
import { classifyCommand, findHarness, type Proc } from "../src/model/harness.ts";

// The pane -> zsh -> claude nesting is the normal shape, not an edge case: a
// direct-children scan misses the harness in most live sessions.
const NESTED: Proc[] = [
  { pid: 100, ppid: 1, command: "-/bin/zsh" },
  { pid: 101, ppid: 100, command: "/bin/zsh" },
  { pid: 102, ppid: 101, command: "/Users/zachary/.local/bin/claude --session-id 72bcbaee-681a-490b-95a2-e3cc21826e92" },
];

describe("classifyCommand", () => {
  test("reads claude and its session id", () => {
    expect(classifyCommand("/Users/zachary/.local/bin/claude --session-id 72bcbaee-681a-490b-95a2-e3cc21826e92")).toEqual({
      kind: "claude",
      sessionId: "72bcbaee-681a-490b-95a2-e3cc21826e92",
    });
  });

  test("reads claude with no session id on the line", () => {
    expect(classifyCommand("/Users/zachary/.local/bin/claude")).toEqual({ kind: "claude", sessionId: null });
  });

  test("reads codex", () => {
    expect(classifyCommand("/opt/homebrew/bin/codex")).toEqual({ kind: "codex", sessionId: null });
  });

  // The desktop app runs as /Applications/Claude.app/... and is not a harness.
  // Matching it would attach a bogus harness to whatever session is nearby.
  test("never matches the Claude desktop app", () => {
    expect(classifyCommand("/Applications/Claude.app/Contents/MacOS/Claude")).toBeNull();
    expect(classifyCommand("/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process")).toBeNull();
  });

  // Matching anywhere in the string would classify any command that merely
  // mentions the word.
  test("matches the binary, not a mention of it", () => {
    expect(classifyCommand("grep claude /var/log/system.log")).toBeNull();
    expect(classifyCommand("vim claude-notes.md")).toBeNull();
  });

  test("ignores an unrelated command", () => {
    expect(classifyCommand("/bin/zsh")).toBeNull();
  });
});

describe("findHarness", () => {
  test("finds a harness nested below the pane process", () => {
    expect(findHarness(NESTED, 100)).toEqual({
      kind: "claude",
      sessionId: "72bcbaee-681a-490b-95a2-e3cc21826e92",
    });
  });

  test("finds a harness that is a direct child", () => {
    const procs: Proc[] = [
      { pid: 200, ppid: 1, command: "-/bin/zsh" },
      { pid: 201, ppid: 200, command: "/opt/homebrew/bin/codex" },
    ];
    expect(findHarness(procs, 200)).toEqual({ kind: "codex", sessionId: null });
  });

  test("returns null when the pane runs no harness", () => {
    expect(findHarness([{ pid: 300, ppid: 1, command: "-/bin/zsh" }], 300)).toBeNull();
  });

  test("never escapes the subtree it was given", () => {
    const procs: Proc[] = [
      { pid: 400, ppid: 1, command: "-/bin/zsh" },
      { pid: 500, ppid: 1, command: "/Users/zachary/.local/bin/claude --session-id aaaaaaaa-0000-0000-0000-000000000000" },
    ];
    expect(findHarness(procs, 400)).toBeNull();
  });

  // A cycle in ppid data (or a pid reused as its own ancestor) must not hang
  // the daemon's poll.
  test("terminates on a cyclic process table", () => {
    const procs: Proc[] = [
      { pid: 600, ppid: 601, command: "/bin/zsh" },
      { pid: 601, ppid: 600, command: "/bin/zsh" },
    ];
    expect(findHarness(procs, 600)).toBeNull();
  });
});
