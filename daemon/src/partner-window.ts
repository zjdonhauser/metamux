// Pure decisions for the two partner-window behaviors.
//
// Both are more intrusive than follow-the-tab: one opens a window on the user's
// desktop, the other hides or destroys one. So both refuse on any uncertainty,
// and neither is on by default.

export interface AutoCreateInput {
  enabled: boolean;
  pairingHealthy: boolean;
  /** Displays holding a cmux window with no Chrome partner. */
  displaysNeedingPartner: number[];
  lastCreateAtByDisplay: Map<number, number>;
  now: number;
}

export interface AutoCreate {
  kind: "create";
  displayId: number;
}

/** Long enough that a burst of activity cannot spray windows across a display,
 * short enough that a genuine new window gets its partner promptly. */
const CREATE_COOLDOWN_MS = 30_000;

export function decideAutoCreate(input: AutoCreateInput): AutoCreate | null {
  if (!input.enabled || !input.pairingHealthy) return null;

  for (const displayId of input.displaysNeedingPartner) {
    const last = input.lastCreateAtByDisplay.get(displayId);
    if (last !== undefined && input.now - last < CREATE_COOLDOWN_MS) continue;
    // One at a time: the next tick re-evaluates against a fresh snapshot rather
    // than acting on a batch that may already be stale.
    return { kind: "create", displayId };
  }
  return null;
}

export interface PartnerCloseInput {
  behavior: "off" | "park" | "close";
  chromeWindowId: number | null;
}

export interface PartnerClose {
  kind: "park" | "close";
  chromeWindowId: number;
}

export function decidePartnerClose(input: PartnerCloseInput): PartnerClose | null {
  if (input.behavior === "off") return null;
  if (input.chromeWindowId === null) return null;
  return { kind: input.behavior, chromeWindowId: input.chromeWindowId };
}
