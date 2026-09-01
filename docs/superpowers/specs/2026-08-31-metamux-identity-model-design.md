# metamux identity model

Status: approved 2026-08-31. Supersedes the ad-hoc linking described in `docs/protocol.md`.

## Why

metamux links tmux sessions, cmux workspaces, Chrome tab groups, Chrome windows, and
displays. Today every link is made a different way, and each way stores a value that its
owner is free to change. The bugs all share one shape: **an observed value is used as an
authoritative key.**

- A cached Chrome `groupId` went stale the moment a group crossed windows.
- Identity is `titleAliasId`, a hash of the display title. Titles are mutable.
- `CMUX_WORKSPACE_ID` is copied into a pane when the pane is created, so a pane can carry
  another workspace's id forever. Five live tmux sessions currently share one id.
- Three mechanisms answer "which Chrome window": `homeChromeWindowId`, `placementOverride`,
  and the space-based join.

The registry shows the result. Seven live tmux sessions produced eighteen non-archived
workspaces, including three duplicates and eight orphans, because nothing authoritative
prunes it.

After this change, every link is a foreign key between **minted** ids, and reconciliation is
one pure function.

## Decisions

| Decision | Value |
|---|---|
| tmux session to workspace | strictly 1:1 |
| Anchor | the tmux session. No tmux session means no linkage, ever |
| Identity | minted id, stamped into the host. Never derived from a title |
| Label | display only. A rename changes nothing else |
| Workspace set | a projection of `tmux list-sessions`, not an accumulating store |
| Chrome tabs outside known groups | never adopted, never auto-create anything |
| Tabs | nodes in the graph, observed only, never persisted |
| Cutover | big bang. No migration of the current registry |

## Entities

```ts
type WorkspaceId    = string;   // minted, stamped into the tmux session option
type CmuxWindowId   = string;   // cmux-provided uuid
type ChromeWindowId = string;   // minted, stamped via a marker tab

interface Workspace {
  id: WorkspaceId;
  sessionName: string;          // rendezvous key. Used ONLY to re-link after a tmux restart
  label: string;                // display only
  cmuxWindowId: CmuxWindowId | null;
  harness: Harness | null;      // observed, snapshotted. See "Harness" below
  archived: boolean;
}

interface WindowPair {
  cmuxWindowId: CmuxWindowId;
  chromeWindowId: ChromeWindowId;
}

interface Harness {
  kind: "claude" | "codex" | "grok";
  sessionId: string | null;   // usually null: see "Harness tracking"
}
```

### Where each minted id is stamped

| Entity | Stamped in | Survives |
|---|---|---|
| tmux session | session option `@metamux_id` | rename, detach, re-attach |
| Chrome window | marker tab `panel.html?win=<id>` | Chrome restart |
| cmux window | cmux window uuid (host-provided) | cmux process lifetime |

A tmux server restart destroys session options. On reconnect metamux re-links by
`sessionName`, then re-stamps `@metamux_id`. That is the only moment a name is consulted.

## The graph

```
Workspace ──N:1──> CmuxWindow
   │                   │
   │                 1:1  (WindowPair)
   │                   ↓
   └──1:1──> TabGroup ──N:1──> ChromeWindow
                 │
                1:N
                 ↓
                Tab
```

## Two paths, and the one rule

There are two routes from a Workspace to a Chrome window.

- **Desired:** `Workspace -> CmuxWindow -> WindowPair -> ChromeWindow`. Built from minted ids.
- **Observed:** `Workspace -> TabGroup -> ChromeWindow`. Read from Chrome on this pass.

They are supposed to agree. The rule is: **when they disagree, move the group so the observed
path matches the desired path.**

Follow-the-tab is not a feature under this model. Moving a workspace to another cmux window
changes `cmuxWindowId`, the desired path resolves elsewhere, and the next pass moves the
group. `follow-tab.ts`, `decideFollowTab`, the holding-window lookup, and the placement
override all collapse into this one comparison.

## State discipline

Three categories. Mixing them is what caused every bug above.

- **Desired.** Small, durable, persisted: `id`, `sessionName`, `label`, `cmuxWindowId`, pairs.
- **Observed.** Large, ephemeral, never persisted: `groupId`, Chrome window ids, tab ids,
  geometry.
- **Snapshotted.** Observed, but written down because the source will be gone when it is
  needed. Only `Workspace.harness` is in this category, and it is labelled as such so it
  cannot be mistaken for desired state.

## Reconciliation

```ts
function reconcile(desired: Desired, observed: Observed): Action[]
```

Pure, total, no I/O. The daemon's loop becomes: gather observed, call `reconcile`, execute
the actions. The janitor stops being a separate pass and becomes rules inside this function.

| Edge | Owner | Resolution | On conflict |
|---|---|---|---|
| Workspace to CmuxTab | metamux | re-derived each pass | missing: respawn. Extra: report |
| Workspace to TabGroup | metamux | by id, then label at runtime | two groups: merge. Zero: create |
| TabGroup to ChromeWindow | Chrome | desired path vs observed path | move toward desired |
| Window to Display | OS | geometry | never stored |
| CmuxWindow to ChromeWindow | derived | the pair | ambiguous: refuse, never guess |

Geometry is consulted in exactly one place: repairing a `WindowPair` after a cmux restart.

## Observers

Each observer owns one question and writes into the desired store or the observed snapshot.

| Observer | Owns | Mechanism |
|---|---|---|
| tmux | the set of workspaces | `set-hook` on session-created/renamed/closed, plus a `list-sessions` poll as backstop |
| cmux event log | placement and activation | JSONL tail, unchanged |
| Chrome extension | observed groups, tabs, windows | existing WebSocket frames |

The tmux observer is new and is the largest risk in this work. tmux hooks are weaker than a
log tail, so the poll is not optional.

## Harness tracking

For each workspace, walk the pane's process tree (recursively, not direct children only) and
record the harness and its session id from the command line. Direct-children detection misses
the common `pane -> zsh -> claude` nesting.

This spec **stores** the field. Restore is a follow-on, not part of this work.

Measured on the live machine, not assumed: a session started by typing `claude` in a pane has
a command line of exactly `claude`, with no `--session-id`. Only a cmux-spawned session
carries one. So `sessionId` is null for most real sessions and a restore cannot rely on it.

The follow-on should therefore restore with `claude --continue` in the workspace's cwd, which
resumes the most recent session there and needs no id at all. Correlating a session id by
matching transcript files under `~/.claude/projects/` by cwd and mtime is a guess, and a guess
does not belong in a durable field.

## Outside-tmux guard

The model makes a non-tmux pane unlinkable, so `metamux open` from one fails loudly. Without
a nudge the failure arrives late. `shell/metamux.zsh` gains a wrapper on `claude` and `codex`
that checks `$TMUX` and offers to start a session first.

## The OS URL handler

`metamux-opener.app` is the registered URL handler. It has no tmux context and no terminal to
print an error to, so "fail loudly" cannot apply to it. **Rule: it passes through to plain
unmanaged Chrome.** That matches "no tmux, no linkage" and keeps OS-level link opens working.

## What is deleted

- `titleAliasId` and title-hash identity
- `groupBy: "title" | "workspace"`
- `CMUX_WORKSPACE_ID` and the `update-environment` line
- the active-workspace fallback in `/open`
- `follow-tab.ts` and `decideFollowTab`
- `placementOverride` and `homeChromeWindowId`
- foreign-group adoption, including the "adopt reality" rule

`metamux open --active` **survives**. It is stated user intent, not the silent fallback.

## Preserved behavior

The deletion list is aggressive, so this is the regression contract. After cutover these must
still work:

- `metamux open` puts a URL in the calling session's group
- F1/F2/F3/F4 navigation and the Left-arrow picker
- reverse sync (activating a group selects the workspace)
- color backflow
- the panel
- janitor: duplicate merge and blank-orphan cleanup inside managed groups
- `metamux current`, `status`, `state`, `focus`, `doctor`

## Cutover

No migration of `registry.json`. It holds eighteen entries for seven sessions, mostly
duplicates and orphans, and carrying it forward would import the garbage this model exists to
prevent.

First run adopts: take the live tmux sessions, stamp `@metamux_id`, and re-link existing tab
groups by label once. That one-shot label match is the only surviving use of the old scheme.

Requires from the user: reload the Chrome extension, re-run `install-shell.sh`, and one daemon
restart.

## Testing

`reconcile()` is pure and total, so each edge gets fixture pairs: a desired state, an observed
state, an expected action list. No browser, no tmux, no daemon. Observers are tested against
recorded frames.

## Follow-ons, deliberately out of scope

- Session restore from the stored harness field
- Auto-renaming a harness session to its tmux session name (a cmux hook change, not this model)
- Requester attribution on `/open`, which would close the diagnostic gap that made the 72-tab
  incident unattributable
