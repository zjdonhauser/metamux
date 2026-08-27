// Thin wrapper around the `cmux` CLI: `cmux identify` (socket-feature probe)
// and `cmux rpc <method> [json-params]` (ports polling, workspace.select for
// reverse sync). I/O boundary -- not unit tested directly; main.ts's smoke
// run against a real cmux-spawned shell is the integration check.

export interface CmuxRpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

function runCmux(args: string[], timeoutMs = 3000): Promise<CmuxRpcResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CmuxRpcResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(["cmux", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "timeout" });
    }, timeoutMs);

    (async () => {
      const [stdout, stderr, exitCode] = await Promise.all([
        Bun.readableStreamToText(child.stdout as ReadableStream<Uint8Array>),
        Bun.readableStreamToText(child.stderr as ReadableStream<Uint8Array>),
        child.exited,
      ]);
      clearTimeout(timer);
      if (exitCode !== 0) {
        finish({ ok: false, error: stderr.trim() || `exit ${exitCode}` });
        return;
      }
      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        finish({ ok: true, data: undefined });
        return;
      }
      try {
        finish({ ok: true, data: JSON.parse(trimmed) });
      } catch {
        finish({ ok: false, error: "invalid JSON from cmux" });
      }
    })().catch((err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

export function identify(): Promise<CmuxRpcResult> {
  return runCmux(["identify"]);
}

export function rpc(method: string, params?: Record<string, unknown>): Promise<CmuxRpcResult> {
  const args = ["rpc", method];
  if (params !== undefined) args.push(JSON.stringify(params));
  return runCmux(args);
}

/** Socket-gated feature probe. Success means the daemon is running from a
 * cmux-spawned shell (has the socket env) -- ports watcher, reverse sync,
 * and window follow can all work. */
export async function probeSocketFeatures(): Promise<boolean> {
  const result = await identify();
  return result.ok;
}

export interface WorkspaceCurrentResult {
  workspaceId: string;
  title: string;
  listeningPorts: number[];
}

/** `cmux rpc workspace.current` -- shape verified against live data
 * 2026-08-27: `{workspace: {id, title, listening_ports: number[], ...}}`. */
export async function getCurrentWorkspace(): Promise<WorkspaceCurrentResult | null> {
  const result = await rpc("workspace.current");
  if (!result.ok || !result.data || typeof result.data !== "object") return null;
  const data = result.data as Record<string, unknown>;
  const workspace = (data.workspace && typeof data.workspace === "object") ? (data.workspace as Record<string, unknown>) : {};
  const workspaceId = workspace.id ?? data.workspace_id;
  if (typeof workspaceId !== "string") return null;
  const title = typeof workspace.title === "string" ? workspace.title : "";
  const listeningPorts = Array.isArray(workspace.listening_ports)
    ? workspace.listening_ports.filter((p): p is number => typeof p === "number")
    : [];
  return { workspaceId, title, listeningPorts };
}

/** `cmux rpc workspace.select {"workspace_id": "..."}` -- syntax verified
 * with a live no-op self-select 2026-08-27 (exit 0, workspace unchanged). */
export function selectWorkspace(workspaceId: string): Promise<CmuxRpcResult> {
  return rpc("workspace.select", { workspace_id: workspaceId });
}

export interface WorkspaceColorSeed {
  sourceId: string;
  /** Always a resolved "#RRGGBB" hex when set (verified live 2026-08-27:
   * custom_color reports the applied hex even when it was originally set
   * via a named cmux.json slot) -- resolveCmuxColor still treats it
   * tolerantly since a "#"-prefixed value passes through unchanged. */
  customColor: string | null;
}

/** Enumerates every workspace's custom_color across every window, via
 * `cmux rpc window.list` + `cmux rpc workspace.list {window_id}` per
 * window (both verified live 2026-08-27). Used once at daemon startup to
 * backfill colors set before the daemon started tailing (set_color/
 * clear_color events only appear in the log from that point forward). */
export async function listAllWorkspaceColors(): Promise<WorkspaceColorSeed[]> {
  const windowsResult = await rpc("window.list");
  if (!windowsResult.ok || !windowsResult.data || typeof windowsResult.data !== "object") return [];
  const windows = (windowsResult.data as Record<string, unknown>).windows;
  if (!Array.isArray(windows)) return [];

  const results: WorkspaceColorSeed[] = [];
  for (const w of windows) {
    const windowId = (w as Record<string, unknown>)?.id;
    if (typeof windowId !== "string") continue;

    const wsResult = await rpc("workspace.list", { window_id: windowId });
    if (!wsResult.ok || !wsResult.data || typeof wsResult.data !== "object") continue;
    const workspaces = (wsResult.data as Record<string, unknown>).workspaces;
    if (!Array.isArray(workspaces)) continue;

    for (const ws of workspaces) {
      const wsObj = ws as Record<string, unknown>;
      const sourceId = wsObj.id;
      if (typeof sourceId !== "string") continue;
      const customColor = typeof wsObj.custom_color === "string" ? wsObj.custom_color : null;
      results.push({ sourceId, customColor });
    }
  }
  return results;
}
