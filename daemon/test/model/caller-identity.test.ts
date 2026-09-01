import { describe, expect, test } from "bun:test";
import { notInTmuxMessage, resolveCallerIdentity } from "../../src/model/caller-identity.ts";

const IN_TMUX = { TMUX: "/private/tmp/tmux-501/default,62786,7" };

describe("resolveCallerIdentity", () => {
  test("reads the session name and its stamped id", () => {
    expect(resolveCallerIdentity(IN_TMUX, "review-team\tmw_abc123\n")).toEqual({
      kind: "tmux",
      sessionName: "review-team",
      metamuxId: "mw_abc123",
    });
  });

  // Every session looks like this right after a tmux server restart. The name
  // still identifies it, and the daemon re-links from there.
  test("reports an unstamped session by name", () => {
    expect(resolveCallerIdentity(IN_TMUX, "review-team\t\n")).toEqual({
      kind: "tmux",
      sessionName: "review-team",
      metamuxId: null,
    });
  });

  test("is not-in-tmux without $TMUX", () => {
    expect(resolveCallerIdentity({}, "review-team\tmw_1\n")).toEqual({ kind: "not-in-tmux" });
  });

  // A failed tmux call must never be read as some other session. Refusing is
  // the behavior that replaces the old silent fallback to the active workspace.
  test("is not-in-tmux when the tmux call failed", () => {
    expect(resolveCallerIdentity(IN_TMUX, null)).toEqual({ kind: "not-in-tmux" });
    expect(resolveCallerIdentity(IN_TMUX, "")).toEqual({ kind: "not-in-tmux" });
  });

  test("tolerates output with no id field at all", () => {
    expect(resolveCallerIdentity(IN_TMUX, "review-team\n")).toEqual({
      kind: "tmux",
      sessionName: "review-team",
      metamuxId: null,
    });
  });

  test("keeps a tab inside a session name out of the id", () => {
    expect(resolveCallerIdentity(IN_TMUX, "odd\tname\tmw_9\n")).toEqual({
      kind: "tmux",
      sessionName: "odd\tname",
      metamuxId: "mw_9",
    });
  });

  // The bug this replaces: a stale CMUX_WORKSPACE_ID in the pane must have no
  // influence at all on which workspace is resolved.
  test("ignores CMUX_WORKSPACE_ID entirely", () => {
    const stale = { ...IN_TMUX, CMUX_WORKSPACE_ID: "5FF54DB8-34A6-413B-B867-9F1E3C25374F" };
    expect(resolveCallerIdentity(stale, "review-team\tmw_abc123\n")).toEqual({
      kind: "tmux",
      sessionName: "review-team",
      metamuxId: "mw_abc123",
    });
    expect(resolveCallerIdentity({ CMUX_WORKSPACE_ID: "5FF54DB8" }, "x\ty")).toEqual({ kind: "not-in-tmux" });
  });
});

describe("notInTmuxMessage", () => {
  test("names the problem and still shows the url", () => {
    const msg = notInTmuxMessage("https://example.com/pr/1");
    expect(msg).toContain("not in a tmux session");
    expect(msg).toContain("https://example.com/pr/1");
  });
});
