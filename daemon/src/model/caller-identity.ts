import type { WorkspaceId } from "./identity.ts";

export type CallerIdentity =
  | { kind: "tmux"; sessionName: string; metamuxId: WorkspaceId | null }
  | { kind: "not-in-tmux" };

/**
 * Works out which workspace is calling, from the tmux session the process is
 * actually in.
 *
 * The old answer was `$CMUX_WORKSPACE_ID`, which is copied into a pane when the
 * pane is created and then never updated. Re-attaching a session from a
 * different cmux window left panes carrying another workspace's id: five live
 * sessions were sharing one. Asking tmux at call time cannot go stale.
 *
 * Pure so the resolution rules are testable without a tmux server. Callers pass
 * the raw `display-message` output; parsing failure is treated as "not stamped",
 * never as a different session.
 */
export function resolveCallerIdentity(env: Record<string, string | undefined>, displayMessageOutput: string | null): CallerIdentity {
  if (!env.TMUX) return { kind: "not-in-tmux" };
  if (displayMessageOutput === null) return { kind: "not-in-tmux" };

  // `#S\t#{@metamux_id}`: the name always renders, the id is empty when unstamped.
  const line = displayMessageOutput.split("\n")[0] ?? "";
  const split = line.lastIndexOf("\t");
  if (split === -1) {
    const name = line.trim();
    return name === "" ? { kind: "not-in-tmux" } : { kind: "tmux", sessionName: name, metamuxId: null };
  }
  const sessionName = line.slice(0, split).trim();
  if (sessionName === "") return { kind: "not-in-tmux" };
  const metamuxId = line.slice(split + 1).trim();
  return { kind: "tmux", sessionName, metamuxId: metamuxId === "" ? null : metamuxId };
}

/** What the CLI prints when a link cannot be placed. Fail loud, and say what to do. */
export function notInTmuxMessage(url: string): string {
  return [
    "metamux: this shell is not in a tmux session, so there is no workspace to open the link in.",
    "Start one with `t <name>` and run this again, or open it yourself:",
    `  ${url}`,
  ].join("\n");
}
