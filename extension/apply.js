import { numericWindowFor } from "./observe.js";

/**
 * Translates one reconcile Action into the Chrome call that performs it.
 *
 * Pure, so the refusals are testable. Every action names a MINTED Chrome window
 * id, and this is the only place it becomes a numeric one. If no live window
 * carries that minted id the action is skipped, never retargeted at a
 * neighbouring window: acting on a guess is what put groups in the wrong place.
 */
export function planChromeCall(action, observation) {
  switch (action.kind) {
    case "createGroup": {
      const windowId = numericWindowFor(observation, action.chromeWindowId);
      if (windowId === null) return { op: "skip", reason: `no live window for ${action.chromeWindowId}` };
      return { op: "createGroup", windowId, label: action.label, workspaceId: action.workspaceId };
    }
    case "moveGroup": {
      const windowId = numericWindowFor(observation, action.toChromeWindowId);
      if (windowId === null) return { op: "skip", reason: `no live window for ${action.toChromeWindowId}` };
      return { op: "moveGroup", groupId: action.groupId, windowId };
    }
    case "mergeGroups":
      return { op: "mergeGroups", fromGroupId: action.fromGroupId, intoGroupId: action.intoGroupId };
    case "archiveGroup":
      return { op: "archiveGroup", groupId: action.groupId };
    case "closeBlankGroup":
      return { op: "closeGroup", groupId: action.groupId };
    // Reported for the human, never acted on: a group metamux did not create is
    // not metamux's to touch.
    case "reportForeign":
      return { op: "skip", reason: `foreign group ${action.label}` };
    default:
      return { op: "skip", reason: `unknown action` };
  }
}

/** Groups the calls so a move never runs before the merge that decides which
 *  group survives, mirroring the ordering the old janitor relied on. */
export function orderCalls(calls) {
  const rank = { mergeGroups: 0, closeGroup: 1, archiveGroup: 2, createGroup: 3, moveGroup: 4, skip: 5 };
  return [...calls].sort((a, b) => (rank[a.op] ?? 9) - (rank[b.op] ?? 9));
}
