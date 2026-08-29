// cmux tab actuator for the tmux port (docs/tmux-port-plan.md §2.4):
// executes tmux-reconcile.ts's CmuxActuatorAction list against the real
// `cmux` CLI. Deliberately a new, separate module from cmux-rpc.ts rather
// than an edit to it (daemon-builder owns that file this round) -- but it
// reuses cmux-rpc.ts's already-proven `rpc()` for the one call where a
// JSON-RPC method already does the job (`window.list`, the same call
// listAllWorkspaceColors() already relies on). Every other action here is
// a direct `cmux <subcommand>` CLI call, the same shape tmux-cmux-sync's
// own `cmux()` wrapper already proved live (see the plan's Appendix).
//
// Not wired into main.ts this round -- these functions are exported for a
// future caller and exercised here only via their pure input/output
// shape (buildXArgs helpers), never by actually spawning `cmux` in tests.

import { rpc } from "./cmux-rpc.ts";

export interface CmuxActuatorResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

function runCmuxCli(args: string[], timeoutMs = 3000): Promise<CmuxActuatorResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CmuxActuatorResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(["cmux", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (err) {
      finish({ ok: false, stdout: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout: "", error: "timeout" });
    }, timeoutMs);

    (async () => {
      const [stdout, stderr, exitCode] = await Promise.all([
        Bun.readableStreamToText(child.stdout as ReadableStream<Uint8Array>),
        Bun.readableStreamToText(child.stderr as ReadableStream<Uint8Array>),
        child.exited,
      ]);
      clearTimeout(timer);
      if (exitCode !== 0) {
        finish({ ok: false, stdout, error: stderr.trim() || `exit ${exitCode}` });
        return;
      }
      finish({ ok: true, stdout });
    })().catch((err) => {
      clearTimeout(timer);
      finish({ ok: false, stdout: "", error: err instanceof Error ? err.message : String(err) });
    });
  });
}

/** A tmux session name is about to be typed into a `tmux new -A -s <name>`
 * command string (spawn's --command, or a literal keystroke via `cmux
 * send`). The existing tool never validates this (plan §1.10/§4) -- a
 * session renamed by hand to contain shell metacharacters could break or
 * inject into that pane's shell. Reject anything that isn't safe to
 * interpolate rather than silently carry the risk forward. Tmux itself
 * already disallows "." and ":" in session names, so this is stricter
 * than tmux requires, not looser. */
export function isSafeSessionName(name: string): boolean {
  return /^[A-Za-z0-9 _-]+$/.test(name) && name.length > 0;
}

export interface SpawnTabParams {
  windowId: string | null; // null = global mode, omit --window
  sessionName: string;
  cwd: string;
}

export interface SpawnTabResult {
  ok: boolean;
  /** Whatever `cmux new-workspace` returned -- a `workspace:N` ref, not a
   * stable UUID (matches tick.py's spawn() exactly; see plan discussion:
   * the real UUID only becomes known on a later tick once the tab is
   * discovered via `cmux workspace list --json` and matched through
   * hostMap). Callers must not persist this as a long-term identifier. */
  tabRef: string | null;
  error?: string;
}

/** Pure -- exported so the exact argv a spawn produces is fixture-testable
 * without ever invoking `cmux`. null for an unsafe session name. */
export function buildSpawnArgs(params: SpawnTabParams): string[] | null {
  if (!isSafeSessionName(params.sessionName)) return null;
  const args = [
    "new-workspace",
    "--name",
    params.sessionName,
    "--cwd",
    params.cwd,
    "--focus",
    "false",
    "--command",
    `tmux new -A -s ${params.sessionName}`,
  ];
  if (params.windowId) args.push("--window", params.windowId);
  return args;
}

export async function spawnTab(params: SpawnTabParams): Promise<SpawnTabResult> {
  const args = buildSpawnArgs(params);
  if (!args) return { ok: false, tabRef: null, error: `unsafe session name: ${JSON.stringify(params.sessionName)}` };
  const result = await runCmuxCli(args);
  if (!result.ok) return { ok: false, tabRef: null, error: result.error };
  const match = result.stdout.match(/workspace:\d+/);
  return { ok: true, tabRef: match ? match[0] : null };
}

export interface RetitleTabParams {
  workspaceRef: string; // UUID or "workspace:N" -- cmux accepts either
  title: string;
}

export function retitleTab(params: RetitleTabParams): Promise<CmuxActuatorResult> {
  return runCmuxCli(["workspace-action", "--action", "rename", "--workspace", params.workspaceRef, "--title", params.title]);
}

export interface ReattachTabParams {
  workspaceRef: string;
  sessionName: string;
}

/** Re-types `tmux new -A -s <name>` + Enter into a tab that's titled for a
 * live session but has no attached client (a restored or manually
 * detached tab) -- see plan §1.6. Two `cmux` calls, matching the existing
 * tool exactly (`send` then a separate `send-key Enter`, not one call
 * with a trailing newline). */
export async function reattachTab(params: ReattachTabParams): Promise<CmuxActuatorResult> {
  if (!isSafeSessionName(params.sessionName)) {
    return { ok: false, stdout: "", error: `unsafe session name: ${JSON.stringify(params.sessionName)}` };
  }
  const sendResult = await runCmuxCli(["send", "--workspace", params.workspaceRef, `tmux new -A -s ${params.sessionName}`]);
  if (!sendResult.ok) return sendResult;
  return runCmuxCli(["send-key", "--workspace", params.workspaceRef, "Enter"]);
}

export function closeTab(workspaceRef: string): Promise<CmuxActuatorResult> {
  return runCmuxCli(["close-workspace", "--workspace", workspaceRef]);
}

export interface ReorderTabsParams {
  windowId: string;
  orderedWorkspaceRefs: string[];
}

/** One `reorder-workspace` call per tab in the desired order, matching
 * the existing tool -- the caller (tmux-reconcile.ts) already diffs
 * current vs. desired order and only emits a reorder action when
 * something is actually out of place, so a converged window never
 * reaches here. */
export async function reorderTabs(params: ReorderTabsParams): Promise<CmuxActuatorResult> {
  let last: CmuxActuatorResult = { ok: true, stdout: "" };
  for (let i = 0; i < params.orderedWorkspaceRefs.length; i++) {
    last = await runCmuxCli(["reorder-workspace", "--workspace", params.orderedWorkspaceRefs[i]!, "--index", String(i), "--window", params.windowId]);
    if (!last.ok) return last;
  }
  return last;
}

export interface SetTabColorParams {
  workspaceRef: string;
  windowId?: string;
  color: string; // "#RRGGBB"
}

export function setTabColor(params: SetTabColorParams): Promise<CmuxActuatorResult> {
  const args = ["workspace-action", "--action", "set-color", "--color", params.color, "--workspace", params.workspaceRef];
  if (params.windowId) args.push("--window", params.windowId);
  return runCmuxCli(args);
}

export function clearTabColor(workspaceRef: string, windowId?: string): Promise<CmuxActuatorResult> {
  const args = ["workspace-action", "--action", "clear-color", "--workspace", workspaceRef];
  if (windowId) args.push("--window", windowId);
  return runCmuxCli(args);
}

export interface ActuatorWindow {
  id: string;
  /** Window ordering, for partition mode's "lowest-index window" fallback
   * (docs/protocol.md, "Window pairing"). */
  index: number;
}

/** Prefers the already-proven `cmux rpc window.list` (via cmux-rpc.ts's
 * exported `rpc()`, the same call listAllWorkspaceColors() uses) over
 * text-parsing `cmux list-windows` -- more robust than the regex the
 * original tool needs when it isn't going through cmux-rpc.ts already. */
export async function listWindows(): Promise<ActuatorWindow[]> {
  const result = await rpc("window.list");
  if (!result.ok || !result.data || typeof result.data !== "object") return [];
  const windows = (result.data as Record<string, unknown>).windows;
  if (!Array.isArray(windows)) return [];
  const out: ActuatorWindow[] = [];
  for (const w of windows) {
    const obj = w as Record<string, unknown> | null;
    if (!obj || typeof obj.id !== "string") continue;
    out.push({ id: obj.id, index: typeof obj.index === "number" ? obj.index : 0 });
  }
  return out;
}

/** `cmux current-window` -- the cmux window with OS keyboard focus (macOS
 * "key window" terminology), used for partition mode's spawn placement
 * (docs/protocol.md, "Window pairing": "a session with NO cmux tab spawns
 * ONE tab, in the FOCUSED cmux window"). A plain CLI subcommand, not
 * `cmux rpc` -- prints the bare window UUID, nothing to JSON-parse. null
 * if the call fails for any reason (no cmux shell, no windows, etc.) --
 * callers fall back to the lowest-index window, same as the contract's
 * own fallback rule. */
export async function getFocusedWindowId(): Promise<string | null> {
  const result = await runCmuxCli(["current-window"]);
  if (!result.ok) return null;
  const id = result.stdout.trim();
  return id.length > 0 ? id : null;
}

export interface ActuatorTab {
  id: string;
  title: string;
  pinned: boolean;
  index: number;
  /** Whether this is the currently-active tab within ITS window (a
   * per-window property -- multiple windows can each have their own
   * `selected: true` tab simultaneously). Partition mode's multi-window
   * legacy convergence uses this to prefer the tab the user is actually
   * looking at when picking which duplicate survives. */
  selected: boolean;
}

/** `cmux workspace list --window <id> --json` -- kept as the direct CLI
 * call (not `cmux rpc workspace.list`) because it's the one already
 * verified live to carry `pinned`/`index`/`title`/`selected` together
 * (plan Appendix); `workspace.list`'s RPC shape wasn't independently
 * confirmed to include all four. */
export async function listTabs(windowId: string): Promise<ActuatorTab[]> {
  const result = await runCmuxCli(["workspace", "list", "--window", windowId, "--json"]);
  if (!result.ok) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const workspaces = (parsed as Record<string, unknown> | null)?.workspaces;
  if (!Array.isArray(workspaces)) return [];
  const out: ActuatorTab[] = [];
  for (const w of workspaces) {
    const obj = w as Record<string, unknown> | null;
    if (!obj || typeof obj.id !== "string") continue;
    out.push({
      id: obj.id,
      title: typeof obj.title === "string" ? obj.title : "",
      pinned: obj.pinned === true,
      index: typeof obj.index === "number" ? obj.index : 0,
      selected: obj.selected === true,
    });
  }
  return out;
}

/** Which cmux window currently holds a workspace, or null. Costs one
 * window.list plus one workspace.list per window, so callers should go through
 * WindowLookup rather than calling this on every event. */
export async function findWorkspaceWindow(workspaceId: string): Promise<string | null> {
  for (const win of await listWindows()) {
    const tabs = await listTabs(win.id);
    if (tabs.some((t) => t.id === workspaceId)) return win.id;
  }
  return null;
}
