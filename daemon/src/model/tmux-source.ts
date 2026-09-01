import type { WorkspaceId } from "./identity.ts";
import type { TmuxSession } from "./project-workspaces.ts";

export const ID_OPTION = "@metamux_id";

/**
 * Parses `list-sessions -F '#{session_name}\t#{@metamux_id}'`.
 *
 * tmux renders an unset user option as an empty field, so absence and empty are
 * the same thing here and both mean "never stamped". Splitting on the LAST tab
 * keeps a session name containing a tab from eating the id.
 */
export function parseSessionList(stdout: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const split = line.lastIndexOf("\t");
    if (split === -1) {
      sessions.push({ name: line, metamuxId: null });
      continue;
    }
    const id = line.slice(split + 1);
    sessions.push({ name: line.slice(0, split), metamuxId: id === "" ? null : id });
  }
  return sessions;
}

/** The hooks that give the projection low latency. The poll is what makes it correct. */
export const HOOK_EVENTS = ["session-created", "session-renamed", "session-closed"] as const;

/**
 * Builds the `set-hook` command for one event.
 *
 * The hook carries no payload and names no session: it is only a nudge that
 * says "something changed, re-project now", and the daemon answers by listing
 * sessions afresh. That is deliberate. `session-renamed` reports the NEW name
 * with no way to say which session it was, so any payload-carrying design would
 * have to guess. Re-listing cannot guess.
 */
export function buildHookCommand(event: string, nudgeUrl: string): string[] {
  return ["set-hook", "-g", event, `run-shell "curl -s -m 1 -X POST ${nudgeUrl} >/dev/null 2>&1 || true"`];
}

function run(args: string[]): { ok: boolean; stdout: string } {
  const proc = Bun.spawnSync(["tmux", ...args]);
  return { ok: proc.exitCode === 0, stdout: new TextDecoder().decode(proc.stdout) };
}

export function listSessions(): TmuxSession[] {
  // A tmux server with no sessions exits non-zero; that is "none", not a failure.
  const result = run(["list-sessions", "-F", `#{session_name}\t#{${ID_OPTION}}`]);
  return result.ok ? parseSessionList(result.stdout) : [];
}

export function stampId(sessionName: string, id: WorkspaceId): boolean {
  return run(["set-option", "-t", sessionName, ID_OPTION, id]).ok;
}

export function paneRootPids(sessionName: string): number[] {
  const result = run(["list-panes", "-t", sessionName, "-F", "#{pane_pid}"]);
  if (!result.ok) return [];
  return result.stdout.split("\n").filter(Boolean).map(Number).filter(Number.isFinite);
}

export function installHooks(nudgeUrl: string): void {
  for (const event of HOOK_EVENTS) run(buildHookCommand(event, nudgeUrl));
}
