import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The guard wraps `claude`, so the paths that MUST NOT change behavior matter
// more than the prompt itself: a scripted or piped harness has nobody to answer
// a question, and a wrapper that stops to ask would hang it.

const SHELL_FILE = join(import.meta.dir, "..", "..", "shell", "metamux.zsh");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metamux-guard-"));
  // A stub that records how it was called, standing in for the real harness.
  const stub = join(dir, "claude");
  writeFileSync(stub, `#!/bin/sh\necho "STUB-RAN $*"\n`);
  chmodSync(stub, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runZsh(script: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["zsh", "-c", `source ${SHELL_FILE} 2>/dev/null; ${script}`], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      REMOTE_SESSION: "",
      CMUX_WORKSPACE_ID: "",
      ...env,
    },
  });
  return new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
}

describe("outside-tmux harness guard", () => {
  test("defines a wrapper for each harness", () => {
    const out = runZsh("whence -w claude codex grok");
    expect(out).toContain("claude: function");
    expect(out).toContain("codex: function");
    expect(out).toContain("grok: function");
  });

  // The critical case: `zsh -c` is not interactive and has no tty, so the guard
  // must run the real binary untouched instead of prompting.
  test("passes through untouched when not interactive", () => {
    const out = runZsh("claude --version");
    expect(out).toContain("STUB-RAN --version");
    expect(out).not.toContain("outside tmux");
  });

  test("preserves arguments exactly, including quoted ones", () => {
    const out = runZsh(`claude -p 'two words' --flag`);
    expect(out).toContain("STUB-RAN -p two words --flag");
  });

  test("stays out of the way inside tmux", () => {
    const out = runZsh("claude --version", { TMUX: "/tmp/fake,1,0" });
    expect(out).toContain("STUB-RAN --version");
    expect(out).not.toContain("outside tmux");
  });

  test("never prompts when stdin is a pipe", () => {
    const proc = Bun.spawnSync(["zsh", "-c", `source ${SHELL_FILE} 2>/dev/null; echo hi | claude -p -`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, REMOTE_SESSION: "", CMUX_WORKSPACE_ID: "" },
    });
    const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
    expect(out).toContain("STUB-RAN");
    expect(out).not.toContain("outside tmux");
  });
});
