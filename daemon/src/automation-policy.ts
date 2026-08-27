// Pure enforcement for config.agentBrowser (docs/protocol.md,
// "Workspace-scoped browser automation"): what an automationRequest op is
// allowed to do at the current permission level. Checked once, server-side
// (POST /automation), before a request ever reaches the extension.

export type AgentBrowserMode = "off" | "read" | "full";

const READ_ONLY_OPS = new Set(["tabContext", "snapshot", "screenshot"]);
const WRITE_OPS = new Set(["navigate", "click", "type"]);

/** true if `opKind` may run under `mode`: "off" allows nothing, "read"
 * allows tabContext/snapshot/screenshot, "full" adds navigate/click/type.
 * An unrecognized op kind is refused under every mode. */
export function toolAllowed(opKind: string, mode: AgentBrowserMode): boolean {
  if (mode === "off") return false;
  if (READ_ONLY_OPS.has(opKind)) return true;
  if (WRITE_OPS.has(opKind)) return mode === "full";
  return false;
}
