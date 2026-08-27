// Pure JSONL line parser. Never throws. Returns null for anything not a
// consumed workspace event (malformed JSON, wrong category, unrecognized name,
// or missing required fields).

export type WorkspaceEventName = "created" | "selected" | "renamed" | "closed" | "colored";

export interface CmuxWorkspaceEvent {
  name: WorkspaceEventName;
  workspaceId: string;
  title: string;
  cwd: string | null;
  bootId: string;
  seq: number;
  occurredAtMs: number;
  /** Only meaningful for `colored` events: the raw cmux color, a "#RRGGBB"
   * hex or a named cmux.json workspaceColors slot (e.g. "Blue"), or null
   * for clear_color. Unresolved -- colors.ts maps this to a Chrome color. */
  color?: string | null;
}

const NAME_MAP: Record<string, WorkspaceEventName> = {
  "workspace.selected": "selected",
  "workspace.created": "created",
  "workspace.renamed": "renamed",
  "workspace.closed": "closed",
};

export function parseLine(line: string): CmuxWorkspaceEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (obj.category !== "workspace") return null;
  const rawName = obj.name;
  if (typeof rawName !== "string") return null;

  const payload = (obj.payload && typeof obj.payload === "object")
    ? (obj.payload as Record<string, unknown>)
    : {};

  let name: WorkspaceEventName;
  let workspaceId: unknown;
  let title: string;
  let color: string | null | undefined;

  if (rawName === "workspace.action") {
    // Real renames and color changes arrive this way (verified against
    // live data 2026-08-27; workspace.renamed does not occur). Other
    // actions are not workspace events we track.
    const params = (payload.params && typeof payload.params === "object")
      ? (payload.params as Record<string, unknown>)
      : {};

    if (params.action === "rename") {
      name = "renamed";
      workspaceId = params.workspace_id ?? obj.workspace_id;
      const titleRaw = params.title ?? params.custom_title ?? payload.title;
      title = typeof titleRaw === "string" ? titleRaw : "";
    } else if (params.action === "set_color" || params.action === "clear_color") {
      name = "colored";
      workspaceId = params.workspace_id ?? obj.workspace_id;
      title = "";
      // set_color's raw color -- a hex or a named cmux.json slot, left
      // unresolved (colors.ts's job); clear_color carries no color param.
      color = params.action === "set_color" && typeof params.color === "string" ? params.color : null;
    } else {
      return null;
    }
  } else {
    const mapped = NAME_MAP[rawName];
    if (!mapped) return null;
    name = mapped;
    workspaceId = payload.workspace_id ?? obj.workspace_id;
    const titleRaw = payload.custom_title ?? payload.title;
    title = typeof titleRaw === "string" ? titleRaw : "";
  }

  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;

  const cwd = typeof payload.cwd === "string" ? payload.cwd : null;

  const bootId = obj.boot_id;
  const seq = obj.seq;
  if (typeof bootId !== "string" || typeof seq !== "number") return null;

  const occurredAtRaw = obj.occurred_at;
  const occurredAtMs = typeof occurredAtRaw === "string" ? Date.parse(occurredAtRaw) : NaN;
  if (Number.isNaN(occurredAtMs)) return null;

  return { name, workspaceId, title, cwd, bootId, seq, occurredAtMs, ...(name === "colored" ? { color } : {}) };
}

export interface WindowFocusedEvent {
  windowId: string;
  workspaceId: string;
  bootId: string;
  seq: number;
  occurredAtMs: number;
}

/** F7 window follow: parse a `category: "window", name: "window.focused"`
 * line. Separate from parseLine because it's a different category the
 * base contract never consumes. Never throws. */
export function parseWindowFocusedLine(line: string): WindowFocusedEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (obj.category !== "window") return null;
  if (obj.name !== "window.focused") return null;

  const payload = (obj.payload && typeof obj.payload === "object")
    ? (obj.payload as Record<string, unknown>)
    : {};

  const windowId = payload.window_id ?? obj.window_id;
  if (typeof windowId !== "string" || windowId.length === 0) return null;

  const workspaceId = payload.workspace_id ?? obj.workspace_id;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;

  const bootId = obj.boot_id;
  const seq = obj.seq;
  if (typeof bootId !== "string" || typeof seq !== "number") return null;

  const occurredAtRaw = obj.occurred_at;
  const occurredAtMs = typeof occurredAtRaw === "string" ? Date.parse(occurredAtRaw) : NaN;
  if (Number.isNaN(occurredAtMs)) return null;

  return { windowId, workspaceId, bootId, seq, occurredAtMs };
}
