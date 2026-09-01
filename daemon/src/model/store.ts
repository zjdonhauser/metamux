import type { Harness, Workspace, WindowPair } from "./identity.ts";

/** Bumping this discards the old file rather than migrating it. */
export const STORE_VERSION = 1;

export interface DesiredState {
  version: number;
  workspaces: Workspace[];
  pairs: WindowPair[];
}

export const EMPTY: DesiredState = { version: STORE_VERSION, workspaces: [], pairs: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHarness(value: unknown): Harness | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  if (kind !== "claude" && kind !== "codex" && kind !== "grok") return null;
  return { kind, sessionId: typeof value.sessionId === "string" ? value.sessionId : null };
}

function parseWorkspace(value: unknown): Workspace | null {
  if (!isRecord(value)) return null;
  const { id, sessionName, label, cmuxWindowId } = value;
  if (typeof id !== "string" || typeof sessionName !== "string" || typeof label !== "string") return null;
  return {
    id,
    sessionName,
    label,
    cmuxWindowId: typeof cmuxWindowId === "string" ? cmuxWindowId : null,
    harness: parseHarness(value.harness),
    archived: value.archived === true,
  };
}

function parsePair(value: unknown): WindowPair | null {
  if (!isRecord(value)) return null;
  const { cmuxWindowId, chromeWindowId } = value;
  if (typeof cmuxWindowId !== "string" || typeof chromeWindowId !== "string") return null;
  return { cmuxWindowId, chromeWindowId };
}

/**
 * Reads the desired state, and is deliberately unforgiving about shape.
 *
 * Anything that is not a version-matched store of this model starts empty. That
 * is what implements the no-migration cutover: the previous registry held 116
 * rows for 7 real sessions, and importing it would import exactly the
 * duplicates and orphans this model exists to prevent. A fresh start plus the
 * one-shot adopt is cheaper and provably clean.
 *
 * A malformed row is dropped rather than throwing, so one bad entry cannot stop
 * the daemon from starting.
 */
export function parseStore(raw: unknown): DesiredState {
  if (!isRecord(raw) || raw.version !== STORE_VERSION) return { ...EMPTY };
  const workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces.map(parseWorkspace).filter((w): w is Workspace => w !== null)
    : [];
  const pairs = Array.isArray(raw.pairs)
    ? raw.pairs.map(parsePair).filter((p): p is WindowPair => p !== null)
    : [];
  return { version: STORE_VERSION, workspaces, pairs };
}

export function parseStoreText(text: string): DesiredState {
  try {
    return parseStore(JSON.parse(text));
  } catch {
    return { ...EMPTY };
  }
}

export function serializeStore(state: DesiredState): string {
  return JSON.stringify({ version: STORE_VERSION, workspaces: state.workspaces, pairs: state.pairs }, null, 2);
}
