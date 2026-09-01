import { isBlankUrl, type Action, type Desired, type Observed, type ObservedGroup } from "./identity.ts";

/**
 * The whole linking contract, as one pure total function.
 *
 * There are two routes from a Workspace to a Chrome window. The DESIRED route
 * runs through minted ids (workspace -> cmux window -> pair -> chrome window).
 * The OBSERVED route is read from Chrome on this pass (workspace -> group ->
 * chrome window). They are meant to agree, and every action below exists to
 * make the observed route match the desired one.
 *
 * Follow-the-tab is not a special case here: moving a workspace to another cmux
 * window changes which pair the desired route resolves through, so the next
 * pass emits a moveGroup on its own.
 *
 * Groups are matched to workspaces by label, which is safe because labels come
 * from tmux session names and those are unique per server. Label is the runtime
 * LOOKUP key, never identity -- identity is the workspace's minted id.
 */
export function reconcile(desired: Desired, observed: Observed): Action[] {
  const actions: Action[] = [];

  const chromeWindowFor = new Map(desired.pairs.map((p) => [p.cmuxWindowId, p.chromeWindowId]));
  const managedLabels = new Set(desired.workspaces.map((w) => w.label));

  const groupsByLabel = new Map<string, ObservedGroup[]>();
  for (const g of observed.groups) {
    const found = groupsByLabel.get(g.label);
    if (found) found.push(g);
    else groupsByLabel.set(g.label, [g]);
  }

  for (const workspace of desired.workspaces) {
    const groups = groupsByLabel.get(workspace.label) ?? [];

    if (workspace.archived) {
      for (const g of groups) actions.push({ kind: "archiveGroup", groupId: g.groupId });
      continue;
    }

    // No cmux window, or a window with no pair yet, means no desired Chrome
    // window. Refuse rather than guess: guessing is what put links in the wrong
    // group under the old active-workspace fallback.
    const target = workspace.cmuxWindowId === null ? undefined : chromeWindowFor.get(workspace.cmuxWindowId);

    if (groups.length === 0) {
      if (target !== undefined) {
        actions.push({ kind: "createGroup", workspaceId: workspace.id, label: workspace.label, chromeWindowId: target });
      }
      continue;
    }

    const [canonical, ...duplicates] = groups;
    for (const extra of duplicates) {
      actions.push({ kind: "mergeGroups", fromGroupId: extra.groupId, intoGroupId: canonical.groupId });
    }
    if (target !== undefined && canonical.chromeWindowId !== target) {
      actions.push({ kind: "moveGroup", groupId: canonical.groupId, toChromeWindowId: target });
    }
  }

  // A group metamux does not manage is never adopted and never becomes a
  // workspace. The only one we touch is a pure placeholder left behind by a
  // group that lost its tabs.
  for (const g of observed.groups) {
    if (managedLabels.has(g.label)) continue;
    if (g.tabs.length > 0 && g.tabs.every((t) => isBlankUrl(t.url))) {
      actions.push({ kind: "closeBlankGroup", groupId: g.groupId });
    } else {
      actions.push({ kind: "reportForeign", groupId: g.groupId, label: g.label });
    }
  }

  return actions;
}
