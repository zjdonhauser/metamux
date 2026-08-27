// tmux source adapter: subprocess wrappers around `tmux`, for the tmux
// port (docs/tmux-port-plan.md §2.3). Tolerant of tmux being absent or
// having no running server -- every function returns an empty result
// rather than throwing, same philosophy as cmux-rpc.ts's own subprocess
// calls. Not wired into main.ts yet; tmux-reconcile.ts is the pure
// consumer of these shapes.

export interface TmuxSession {
  /** The "$N" form (tmux's #{session_id}), stable across a rename for the
   * life of the tmux server -- NOT #{session_name}, which is the mutable
   * title a user can change at any time. See plan §2.1 for why the
   * distinction matters for a registry sourceId. */
  id: string;
  name: string;
  attached: number;
}

/** cmux workspace UUID -> tmux session id, for every workspace currently
 * hosting a live tmux client. Content-based (the client's inherited
 * CMUX_WORKSPACE_ID env var, read via `ps eww`), never title-based -- see
 * plan §1.5. tick.py's equivalent join keys by session NAME; this keys by
 * session id instead (both are 1:1 with the live session at any given
 * tick, so this doesn't change which session a tab resolves to -- it
 * changes what tmux-reconcile.ts and its registry intents can rely on
 * staying stable across a rename, per the plan's §2.1 argument). */
export type HostMap = Map<string, string>;

interface RunResult {
  ok: boolean;
  stdout: string;
}

async function run(cmd: string[]): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { ok: exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Splits `tmux ... -F 'a\tb\tc'` output into rows. A literal tab char in
 * the format string (not the two-character "\t" some shells would need
 * quoting for) -- Bun.spawn passes argv elements through unescaped, so
 * this is a real tab byte tmux receives directly, verified live. */
function splitTsvLines(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

/** Pure parse of `tmux list-sessions -F session_id\tsession_name\t
 * session_attached` output. Exported (unlike splitTsvLines) specifically
 * so this is fixture-testable without a real tmux server -- the actual
 * I/O in listSessions() below is a thin wrapper around this. */
export function parseSessionsOutput(stdout: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  for (const row of splitTsvLines(stdout)) {
    const [id, name, attachedRaw] = row;
    if (!id || !name) continue;
    const attached = Number(attachedRaw);
    sessions.push({ id, name, attached: Number.isFinite(attached) ? attached : 0 });
  }
  return sessions;
}

/** `tmux list-sessions`. [] if tmux isn't installed, has no running
 * server, or the call fails for any other reason -- never throws. */
export async function listSessions(): Promise<TmuxSession[]> {
  const { ok, stdout } = await run(["tmux", "list-sessions", "-F", "#{session_id}\t#{session_name}\t#{session_attached}"]);
  return ok ? parseSessionsOutput(stdout) : [];
}

/** Pure parse of the content-based join's two subprocess outputs (plan
 * §1.5/§2.3): `tmux list-clients -F client_pid\tsession_id` and `ps eww -o
 * pid=,command=` for those same pids. Exported for fixture testing --
 * hostMap() below is the thin I/O wrapper. */
export function parseHostMapOutput(clientsStdout: string, psStdout: string): HostMap {
  const pidToSessionId = new Map<string, string>();
  for (const [pid, sessionId] of splitTsvLines(clientsStdout)) {
    if (pid && sessionId) pidToSessionId.set(pid, sessionId);
  }
  if (pidToSessionId.size === 0) return new Map();

  const map: HostMap = new Map();
  for (const line of psStdout.split("\n")) {
    const pidMatch = line.match(/^\s*(\d+)\s/);
    const envMatch = line.match(/CMUX_WORKSPACE_ID=([0-9A-Fa-f-]+)/);
    if (!pidMatch || !envMatch) continue;
    const sessionId = pidToSessionId.get(pidMatch[1]!);
    if (sessionId) map.set(envMatch[1]!, sessionId);
  }
  return map;
}

/** The content-based join (plan §1.5/§2.3): `tmux list-clients` for each
 * client's pid + the id of the session it's attached to, then `ps eww` on
 * those pids to read back each client process's inherited
 * CMUX_WORKSPACE_ID env var. Empty map on any failure at any step -- a
 * degraded host map just means the reconcile treats every tab as
 * unhosted this tick, not a crash. */
export async function hostMap(): Promise<HostMap> {
  const clients = await run(["tmux", "list-clients", "-F", "#{client_pid}\t#{session_id}"]);
  if (!clients.ok) return new Map();

  const pidToSessionId = new Map<string, string>();
  for (const [pid, sessionId] of splitTsvLines(clients.stdout)) {
    if (pid && sessionId) pidToSessionId.set(pid, sessionId);
  }
  if (pidToSessionId.size === 0) return new Map();

  const ps = await run(["ps", "eww", "-o", "pid=,command=", "-p", [...pidToSessionId.keys()].join(",")]);
  if (!ps.ok) return new Map();

  return parseHostMapOutput(clients.stdout, ps.stdout);
}

/** "partition" added for the window-pairing model (docs/protocol.md,
 * "Window pairing (partition model, replaces mirroring)") -- it has no
 * TMUX_CMUX_MIRROR env equivalent, since that env var only ever existed
 * for the legacy tmux-cmux-sync tool's windows/global modes. */
export type MirrorMode = "windows" | "global" | "partition";

/** TMUX_CMUX_MIRROR-equivalent resolution: a recognized env override wins,
 * else the given default, else "windows" (matching the existing tool's
 * default). `env` is injectable so this is directly unit-testable without
 * mutating process.env -- same "collaborators come in by injection" shape
 * as the rest of this codebase's pure functions. "partition" is never read
 * from the env var (legacy tool never had it) but is a valid defaultMode. */
export function resolveMirrorMode(
  defaultMode: MirrorMode = "windows",
  env: Record<string, string | undefined> = process.env,
): MirrorMode {
  if (env.TMUX_CMUX_MIRROR === "global" || env.TMUX_CMUX_MIRROR === "windows") return env.TMUX_CMUX_MIRROR;
  return defaultMode;
}
