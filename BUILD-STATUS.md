# metamux build status

Session breadcrumbs for resume. Update as you go, not at the end.
Rules: stage-only (git add, NO commits until Zac says so). Contract = docs/protocol.md.

## Target (morning deliverable)

Working v1 locally: daemon tails cmux events → real-Chrome tab group per workspace switches in lockstep. Zac's morning steps must be exactly the QUICKSTART in README.md.

## Checklist

- [x] Repo scaffold, git init
- [x] docs/protocol.md (the contract)
- [x] package.json / tsconfig / .gitignore
- [x] Daemon (Sonnet worker): parser (incl. workspace.action rename), registry, gate, tail, server, doctor; 55 tests green (76 repo-wide with extension's 21; `bunx tsc --noEmit` clean repo-wide)
- [x] CLI: metamux open/status/state/secret/doctor (round-tripped against live daemon)
- [x] scripts/fake-extension.ts harness
- [x] Extension (Sonnet worker): manifest, reducer (19 tests green), sw.js, chrome-ops.js, ws.js, panel, options
- [x] README QUICKSTART + layout/metamux-dock.lua (written by supervisor)

## Phase 2 (overnight continuation, Zac asked for max features by morning)

- [x] Ports watcher F8 (socket-gated; guards being added: first-poll baseline, <49152 cutoff, 2-per-cycle cap after the 28-ephemeral-ports trap showed in live smoke)
- [x] Reverse sync F9 daemon half (userActivatedGroup → guard → verified `cmux rpc workspace.select '{"workspace_id":...}'`)
- [x] Window follow F7 (real `window.focused` signal found, live-tail only by design)
- [x] `metamux focus` + POST /focus (live-verified)
- [x] MCP server `metamux mcp` (stdio JSON-RPC, 3 tools, real-subprocess integration test)
- [x] launchd script (NOTE: an inert, unloaded com.metamux.daemon.plist was written to ~/Library/LaunchAgents during verification; delete if unwanted)
- [x] Daemon Phase 2: 129 tests green, tsc clean, live smoke w/ socket features enabled ✓
- [x] Reverse sync F9 extension half (user-click reporting + 1500ms echo suppression via markServerActivation op; daemon half pending)
- [x] focusWindow op + tests asserting activation NEVER focuses (F3 intact)
- [x] Extension Phase 2 verified: 32 ext tests, e2e re-run ALL PASS, ports pills render
- [x] Window follow F7 (real window.focused signal, live-tail only)
- [x] `metamux focus` (explicit CLI → focus_window event → focusWindow op)
- [x] MCP server `metamux mcp` (stdio, 3 tools; supervisor-verified live: initialize/tools list/metamux_current all correct)
- [x] launchd install script (script only, not loaded)
- [x] Panel polish (active workspace, ports links, status)
- [x] skills/metamux/SKILL.md (agent skill, personal-install via plugin-builder later)
- [x] README Phase 2 section + final e2e re-run (ALL PASS) + git add (47 files staged)

PHASE 2 COMPLETE 2026-08-27 ~03:50 UTC. Final numbers: 140 tests green, tsc clean,
real-Chromium e2e 5/5, MCP live-verified, ports tab-bomb guarded (baseline + <49152 + cap 2).

## Zero-command layer (2026-08-27 morning, per Zac's feedback: no typed commands)

- [x] metamux skill installed at ~/.claude/skills/metamux (agents auto-open their URL deliverables)
- [x] MCP registered user-scope: `claude mcp add --scope user metamux -- bun <repo>/cli/metamux.ts mcp`
- [x] PostToolUse Bash hook LIVE in ~/.claude/settings.json (async, 5s timeout): PR/compare URLs in any
      Bash output auto-open in that session's workspace group; 1h dedupe cache; live-fire verified
- [x] SwiftBar menubar plugin installed (~/.config/swiftbar-plugins/metamux.5s.sh): active workspace,
      focus button, open-clipboard-URL, reverse-sync toggle
- [x] Dock button NOT installed, deliberately: cmux dock controls are seed-once panes, not click
      buttons; a focus control would fire on every new workspace (surprise focus steal). Example kept
      at layout/dock.json.example. The menubar is the button.

## Color mirroring + live toggles (2026-08-27 midday)

- [x] cmux workspace colors mirror to Chrome groups: hue-first HSL mapping (grey when sat<0.15 or
      extreme lightness; else nearest of 8 chromatic swatch hues). Navy #152744 → blue (was green
      under Euclidean RGB, fixed). Startup backfill via cmux rpc window.list/workspace.list
      custom_color. Fallback stays title hash. Live-verified set/clear round trip.
      Accepted close calls: Teal #0E9F6E→green (2.8° margin), Aqua→blue, Green slot #047857→cyan (3.6°).
- [x] Config hot-reload: ~300ms apply for reverseSync/collapseOthers/closeBehavior/debounceMs/ports.*;
      port/eventsPath log "restart required". Sync frame re-pushed to clients on extension-relevant keys.
- [x] SwiftBar v2 INSTALLED: Experimental features submenu generated from `metamux config --json`
      (new flags auto-appear); boolean toggles, enum cycling, live via hot-reload.
- [x] `metamux current` CLI added (skill documented it before it existed; gap closed, live-verified).

Final numbers: 246 tests green, tsc clean, e2e 5/5 (re-run after all changes).

## Live install state (2026-08-27, Zac's machine)

- Daemon running detached, auto-ensured by .zshrc (scripts/ensure-daemon.sh, tmux-cmux-sync pattern)
- Extension loaded + connected (clients >= 1), options saved
- SwiftBar plugin v3 STREAMABLE installed (metamux.sh -> metamux-stream.ts over WS; no polling,
  60s heartbeat safety net; replaces 5s/30s cron versions and the grey-out failure class)
- Demo performed: this Claude session's page opened into the calling shell's workspace group
  via `metamux open` (note: targets the CALLER's workspace by design; possible ergonomic
  follow-up: `metamux open --active`)

## Grouping rework (2026-08-27 afternoon)

- [x] groupBy "title" (default): same-title workspaces alias to one identity (t_ ids, pure
      GroupProjection); live-verified 43 workspaces -> 25 identities, same alias from 2 windows
- [x] createGroups "lazy" (default): groups materialize on first activation/open_url
- [x] Reverse sync resolves aliases to the active/first live member
- [ ] attachedAt persistence + protocol.md projection docs (in flight)
- [ ] tmux absorption: docs/tmux-port-plan.md in flight (tmux session = identity; cmux tabs and
      Chrome groups both become actuators; absorbs ~/bin/tmux-cmux-sync)
- NOTE: pre-dedupe duplicate Chrome groups are orphaned; user closes them once manually.

## Browser lifecycle rework + activation (2026-08-27 late afternoon)

- [x] Cutover PERFORMED ~14:41 UTC by supervisor (Zac's direct authorization): old tmux-cmux-sync
      stopped (needed SIGTERM escalation after 2x SIGINT; runbook corrected by reality), .zshrc
      block commented with superseded marker, tmux.enabled=true via hot-reload, migration
      reclassified 6 sessions / archived 6 legacy refs, live-proven 3x with throwaway sessions
      (spawn into both windows, reap on kill, real sessions untouched).
- [x] Tab-group janitor (extension): merge duplicates into canonical, close blank orphans, report
      foreign untouched; `janitor` config hot-applied.
- [x] createGroups "on-open" (new default): groups exist only when a real tab opens for a session;
      activation never creates; user closing a group detaches it (userClosedGroup). "lazy" file
      value reads as "on-activate".
- [x] Color backflow: paints cmux tabs (persisted paintedColor) to match Chrome groups; user colors
      always win; loop-safe (9 fixed-point tests). Crosswin decision recorded: never tab color.
- [x] e2e-chromium fully isolated (METAMUX_PORT/STATE_DIR/CONFIG_PATH, own daemon, live-PID proof)
      with janitor + on-open live assertions: 5/5 ALL PASS x5 runs. Final: 468 tests, tsc clean.
- Activation: daemon restart picks all of this up; extension needs ONE manual reload in
  chrome://extensions for janitor/on-open/detach code.

## tmux absorption -- code complete (2026-08-27; cutover status above)

Everything in `docs/tmux-port-plan.md` is now implemented and staged (uncommitted, per Zac's
rule) on branch `tmux-absorption`:

- [x] Phase 0: `Registry.findMatch`'s title/cwd fallback scoped by `source` (TDD -- a
      tmux-sourced ref and a same-titled cmux ref never re-bind to each other).
- [x] Registry model: `WorkspaceRef.source: "cmux" | "tmux"`; `applyTmuxIntent`
      (upsert/archive, idempotent); `reclassifyAsTmux` + `archiveBySourceId` for migration
      (preserves `mw_` id -> Chrome group survives reclassification).
- [x] `daemon/src/tmux-source.ts`, `daemon/src/cmux-actuator.ts`, `daemon/src/tmux-reconcile.ts`
      (pure core, built in an earlier session on this branch) now WIRED into `daemon/src/main.ts`:
      `pollTmux` on a 2s timer (socket-gated, config.tmux.enabled hot-reloadable with no separate
      timer start/stop), `executeTmuxAction` dispatches reconcile output to the actuator, results
      feed both `Registry.applyTmuxIntent` and `server.broadcast`.
- [x] `daemon/src/tmux-migration.ts` (new): pure `planMigration` + `loadLegacyState`, wired to run
      once at startup and again on any live `tmux.enabled` false->true toggle (idempotent, no
      marker file needed).
- [x] Config: `tmux.{enabled,mirror,alphabetize,reattachGraceMs,spawnCwd}`, all 5 hot-reloadable,
      `tmux.mirror` falls back to `TMUX_CMUX_MIRROR` env only when unset in config.json.
- [x] `docs/protocol.md` updated: Registry section, new "tmux source + cmux actuator" section
      covering the source adapter, actuator, reconcile semantics (both mirror modes), wiring,
      config, and the migration.
- [x] Crosswin badges: NOT ported this round -- deferred, not half-built. tick.py's tab-color
      crosswin logic (plan §1.8) needs its own reconcile-adjacent pure function and wiring;
      keeping it out of this round rather than landing a partial version. Sole remaining thing
      genuinely deferred from the plan (global-mode reattach WAS implemented, closing that gap).
- [x] `bun test`: 407 pass, 0 fail (up from 246 at the start of this round). `bunx tsc --noEmit`:
      clean.
- [ ] **Live migration (plan §3, plan step 5 of this round's task) NOT performed.** This is a
      deliberate stop, not an oversight -- see below.

### Why the live cutover wasn't executed

The remaining step is: kill the real, currently-running `tmux-cmux-sync` process serving Zac's
actual tmux/cmux mirroring, comment out its `.zshrc` lines, restart the real `metamuxd` with
`tmux.enabled: true`, and create/destroy a real tmux session to verify. That's live surgery on
Zac's actual working environment (his shell profile, his daily-driver session-mirroring, mid
workday) -- categorically different from every other action taken on this branch so far, which
was all reversible, in-repo, uncommitted code. Per this agent's operating rules, another agent's
relayed "the user confirmed" is explicitly NOT sufficient authorization for an action this
consequential; that has to come from Zac directly, or from someone executing it with their own
authorization rather than a worker agent doing it unprompted from a relayed instruction.

**Everything needed to execute the cutover is ready and documented** (plan §3.2 has the exact
kill order):

1. `kill -INT $(cat ~/.local/state/tmux-cmux-sync.pid)` -- **`-INT`, not a bare `kill`**: the
   plan's own finding is that tmux-cmux-sync's Python loop has no SIGTERM handler, so a plain
   `kill` leaves a stale pidfile; SIGINT unwinds through its `finally:` cleanly.
2. Comment out (don't delete) `.zshrc` lines ~371-374 (the `tmux-cmux-sync --ensure` block),
   with a `# superseded by metamux (tmux-absorption)` marker.
3. Set `tmux.enabled: true` in `~/.config/metamux/config.json` (or `metamux config tmux.enabled
   true` once this branch is live).
4. Restart metamuxd via `scripts/ensure-daemon.sh` (or let the next cmux shell's existing
   `.zshrc` line at ~406 do it).
5. Verify: `tmux new -d -s mm-port-test`, confirm a cmux tab appears in every window and a
   Chrome-group identity exists for it, then `tmux kill-session -t mm-port-test` and confirm the
   tabs reap. Never touch a real session other than `mm-port-test`.
6. Rollback if anything looks wrong: `tmux.enabled: false` in config (hot-reload, no restart
   needed), restore the `.zshrc` block, `~/bin/tmux-cmux-sync --ensure`.

### Verification still done this round (safe, non-destructive)

- Full `bun test` (407/407) and `bunx tsc --noEmit` (clean) against the wired code.
- `daemon/test/tmux-migration.test.ts`, `daemon/test/registry.test.ts` (new Phase 0 + intent/
  reclassify/archive cases), `daemon/test/paths-config.test.ts` (new tmux config block +
  TMUX_CMUX_MIRROR precedence cases) all pass.
- Did NOT touch the real `tmux-cmux-sync` process, `.zshrc`, or any real tmux session -- the
  live daemon on Zac's machine is still running the pre-tmux-absorption build, unaffected.

## Known minors (fix later, not blockers)

- ~~Extension: offline-archived workspace not collapsed by next sync~~ FIXED (TDD, 21/21 green).
- ~~Duplicate titles map to one group~~ DISPROVED by the real-Chromium e2e: each workspace id
  gets its own distinct group even when titles collide (verified with the two live "compliance"
  workspaces). Title-based re-resolution after a Chrome restart could still cross-wire two
  same-titled groups; harmless (same title/color), noted for Phase 2.
- scripts/e2e-chromium.ts: real-browser e2e, ALL 5 assertions PASS (2026-08-27 ~03:20 UTC).
  Manual pre-flight tool, not CI-safe: drives live cmux state and hardcodes the Playwright
  chromium-1234 cache path.
- [x] Walking-skeleton smoke: daemon + fake-extension against REAL ~/.cmuxterm/events.jsonl (seeded 31 ws / 24 archived, sync snapshot delivered)
- [x] Live round-trip smoke 2026-08-27 03:04 UTC: `cmux rpc workspace.next` → activated "compliance" received by fake client in ~260ms incl. 200ms debounce; `workspace.previous` restored "cmux". PASS.
- [ ] README QUICKSTART (4 steps, top of file)
- [ ] layout/metamux-dock.lua (Hammerspoon, optional)
- [x] git add -A (staged, uncommitted)

## Current state

BUILD COMPLETE (2026-08-27 ~03:10 UTC). 76 tests green, tsc clean, live round-trip smoke PASSED
(daemon + fake extension against real cmux: workspace.next/previous produced activated events
in ~260ms incl. debounce). Everything staged, nothing committed (Zac's rule).

Remaining is HUMAN-ONLY (Zac's morning, see README QUICKSTART): load the unpacked extension,
paste port+secret in its options, watch tab groups follow cmux. First real-Chrome run may
surface chrome-ops.js issues the fake client can't catch (group creation, marker window,
collapse behavior); debug via the marker tab status + service-worker console + `metamux doctor`.

## How to run

- Tests: `bun test` (repo root)
- Daemon: `bun daemon/src/main.ts` (or `bun run daemon`)
- Fake extension: `bun scripts/fake-extension.ts`
- Doctor: `bun daemon/src/main.ts doctor` (or `metamux doctor` once CLI linked)

## Known facts (verified earlier this session)

- cmux events log: `~/.cmuxterm/events.jsonl`, rotated 16MiB, auth-free. `workspace.selected` payload carries workspace_id/title/cwd/index/previous_workspace_id/tab_count; boot_id+seq per line.
- Bun 1.3.14, Node v24.15.0 available.
- Chrome tabGroups: 9 colors; groupId unstable across restarts; cross-window move fires onCreated.
- CDP on real profile is dead (Chrome 136+); extension is the only channel.
- tmux-cmux-sync creates/renames workspaces programmatically → the 500ms created→selected suppression rule in the contract exists for this.

## Color backflow (2026-08-27, queued after tmux absorption wiring)

Cmux tabs now visually match their Chrome group ("a colored flag that matches the color of the
browser tab the cmux tab relates to" -- Zac), fully implemented, tested, and LIVE-VERIFIED:

- [x] `daemon/src/color-backflow.ts` (new, pure): `computeBackflowCandidates` (groups live
      cmux refs by groupBy identity, resolves each identity's color exactly like
      `group-projection.ts` does), `decideBackflow` (the full paint/skip/repaint matrix --
      never-touched, user-cleared-our-paint, already-matches dedupe, our-stale-paint,
      user-owned), `planBackflow` (orchestrates decideBackflow across candidates).
- [x] `colors.ts`: `CHROME_GROUP_REPRESENTATIVE_HEX` (all 9 Chrome colors, grey included) --
      a proven FIXED POINT of `nearestChromeGroupColor` (TDD'd in `colors.test.ts`), the
      loop-safety guarantee: a backflow-painted color can never trigger a different downstream
      color and chase itself.
- [x] `WorkspaceRef.paintedColor` (new field, persisted like `attachedAt`) + `Registry.markPainted`
      distinguish backflow's own paint from a user-set color -- the eligibility check is one
      comparison (`cmuxColor !== null && cmuxColor !== paintedColor` => user-owned, skip),
      no separate ownership flag needed.
- [x] Wired into `main.ts`: `pollColorBackflow` on a 5s socket-gated timer (same
      unconditional-timer-with-internal-gate shape as `pollTmux`, so `config.colorBackflow` is
      hot-reloadable with no separate start/stop logic).
- [x] Config: `colorBackflow: true` default, allowlisted/validated/hot-reloadable.
- [x] Crosswin interplay: DECIDED, not built (crosswin itself stays deferred). Documented in
      `docs/protocol.md`'s new "Color backflow" section -- when crosswin is eventually built it
      must NOT use tab color (backflow now owns that field persistently); it needs its own
      channel (`cmux set-status`, revisiting whether pills actually don't render in Zac's
      current sidebar config, or something else).
- [x] `bun test`: 433 pass, 0 fail (up from 407). `bunx tsc --noEmit`: clean.
- [x] **Live-verified** against a real, disposable cmux workspace (`mm-backflow-test`, created
      in a real window via `cmux new-workspace`): ran the actual `cmux-actuator.ts` +
      `color-backflow.ts` production code (not a reimplementation) end to end -- planned one
      paint action, executed it via `setTabColor`, confirmed via `cmux workspace list --json`
      that `custom_color` really changed to the expected hex on the live tab, confirmed a
      second pass with the now-painted state produces zero actions (dedupe), confirmed a
      differently-colored ref produces zero actions (user-owned exclusion), then closed the
      throwaway workspace and confirmed it's gone. Nothing else was touched -- did not run this
      against the live production daemon's full registry (which would have painted every real
      tab with a fallback color, out of scope for "one throwaway workspace").

## Window-split fix (2026-08-27) -- diagnose-by-design, TDD

Live bug on Zac's machine: after an extension reload, two full group sets existed side by side,
cmux switching kept driving the original set, and the janitor reported nothing. Diagnosed root
cause (supervisor): `resolveMetamuxWindow` picked a different window post-reload (the original
marker tab was closed during manual cleanup); stale cached groupIds kept working cross-window
(chrome APIs accept a groupId regardless of window) while `ensureGroup` rebuilt a second set in
the new window and the janitor, scoped to that new window only, never saw the old one.

- [x] **Cache invalidation on window resolution**: `reducer.js`'s new `resolveGroupCache` checks
      every cached groupId against a snapshot of ALL windows' groups, not just the managed one --
      a groupId that belongs to the wrong window (or doesn't exist at all) is corrected by title
      re-resolution within the target window, else nulled. This is the actual fix for the
      reported symptom (a stale cross-window groupId silently working for activation).
- [x] **Window adoption**: `reducer.js`'s new `chooseAdoptionWindow` -- zero marker tabs no
      longer always means "create a brand-new window"; it now adopts the window with the most
      managed-title groups if one exists, only falling back to create-new as a true last resort.
      Multiple marker tabs (a prior-boot leftover): keeps the group-richest window's, closes the
      rest.
- [x] **Cross-window recovery merge**: `classifyJanitor` extended with a `foreignGroups` param --
      managed-title groups in OTHER windows get `recoverCrossWindow`'d (tabs.move then
      tabs.group) into the in-window canonical, once one exists; unmanaged titles in other
      windows are never touched, same as the in-window janitor's own FOREIGN classification.
      Config `janitorCrossWindow: true` default, daemon config plumbing done (allowlist/
      validate/hot-reload/sync-frame/protocol.md).
- [x] All three are PURE decision functions in `reducer.js`, fed snapshots gathered by thin
      `chrome-ops.js`/`sw.js` glue -- same "reducer stays pure" pattern as the base janitor.
      `extension/test/reducer.test.js`: 20 new tests (54 -> 74) covering the full matrix for all
      three plus an "isolated e2e" scenario test that walks the exact incident end to end
      (stale-window boot -> cache invalidation -> first sync with no in-window canonical yet ->
      second sync recovers cross-window -> activation never once targets the old window's real
      groupIds).
- [x] "Isolated e2e" interpreted as a self-contained, CI-safe reducer-level scenario test (no
      real Chrome/daemon), not an extension of `scripts/e2e-chromium.ts` (the real-Chromium
      harness, already flagged there as "manual pre-flight, not CI-safe") -- flagging this
      interpretation explicitly in case a real-browser second-window scenario is still wanted as
      a separate follow-up.
- [x] `bun test`: 558 pass, 0 fail (up from 540 at the start of this fix). `bunx tsc --noEmit`:
      clean.
- Not yet activated live: per the task, the supervisor activates this (Zac reloads the extension
  once) -- not performed here, same category of live-environment action as the tmux cutover.

## Color backflow: paint swatch hexes, not brand hexes (2026-08-27)

Zac feedback on the live system: painted cmux tab colors visibly didn't match their Chrome group
-- we were painting `colorMode: "palette"`'s brand hexes (e.g. `#2779FB`), Chrome renders its own
fixed swatches for the same `chromeColor` name. Fix: backflow now ALWAYS paints
`CHROME_GROUP_REPRESENTATIVE_HEX[chromeColor]` (the exact hex `colorMode: "hash"` already used),
in both colorModes -- `colorMode` only changes which `chromeColor` an identity resolves to, never
what hex gets painted for it.

- [x] `color-backflow.ts`: dropped the `colorMode === "palette"` branch that used
      `palette[i].hex`; `targetHex` is now unconditionally the swatch hex.
- [x] `palette.ts` simplified: `PaletteEntry` drops `hex` (down to `{name, chromeColor}`);
      `FALLBACK_HEXES` and the `cmux.json` hex-reading deleted entirely (nothing consumes hex
      anymore); `buildPalette()`/`loadPalette()` are now pure/no-I/O, kept `async` on
      `loadPalette` only so `main.ts`'s existing `await` call sites didn't need touching. The
      ordering + first-9-distinct-`chromeColor` property (the only thing that was ever
      load-bearing for allocation) is untouched.
- [x] Repaint convergence verified explicitly: a ref with `cmuxColor === paintedColor === ` an old
      brand hex is NOT user-owned (backflow still recognizes it as its own prior paint) and DOES
      get repainted to the new swatch-hex target -- exactly what every already-painted live tab
      looks like the moment this build restarts. Tested at both the `decideBackflow` matrix level
      and end-to-end through `computeBackflowCandidates`/`planBackflow`, both colorModes.
- [x] Loop safety unchanged in substance, simplified in practice: the old `colorMode: "palette"`
      "ownership-echo trap" (an allocated brand hex hue-mapping to a DIFFERENT chromeColor than
      its own allocation) can't happen anymore -- there's no brand hex left to disagree with
      anything. `colors.test.ts`'s existing fixed-point test already covers it.
- [x] `docs/protocol.md` updated: "The palette" (drops hex description), "Color backflow" (new
      swatch-hex-always framing + why), "Loop safety" (simplified, palette caveat removed).
- [x] `bun test`: 565 pass, 0 fail. `bunx tsc --noEmit`: clean.
- Not activated live -- supervisor's call (a daemon restart repaints every backflow-owned tab to
  the matching swatch hex).

## Window pairing (partition model, replaces mirroring) -- daemon half (2026-08-27 evening)

Zac's directive: mirroring dies. Each tmux session lives in exactly one cmux tab and one Chrome
group; Chrome windows pair 1:1 with cmux windows. Full contract in `docs/protocol.md`'s "Window
pairing" section. This round is the DAEMON HALF ONLY, per the task's explicit scope -- the
extension half (marker-tab-per-window, per-window group creation/activation/janitor, the
`groupPlacement`/`windowPairing` frame senders) is a separate follow-up task.

- [x] `tmux-reconcile.ts` gains `"partition"` mirror mode: a session with no cmux tab spawns ONE
      tab in the FOCUSED cmux window (fallback: lowest-index window, and zero-windows is a safe
      no-op). A session with tabs in MULTIPLE windows (mirror-era legacy, or the routine "both
      windows happen to have `selected: true`" case) converges to ONE: prefers a `selected: true`
      candidate; if none or more than one, falls back to lowest window index. Reaps every other
      duplicate the same tick. A tab moving between windows (user drag) is respected -- the
      tracked attachment just updates to wherever it's actually found. `alphabetize` is kept
      (UX parity with windows mode, not in the original contract text but cheap to preserve).
- [x] `cmux-actuator.ts`: `listWindows()` now returns `index`; new `getFocusedWindowId()` (`cmux
      current-window`); `listTabs()` now returns `selected`.
- [x] TDD, including a dedicated "Zac's real shape" test: 8 sessions x 2 windows, every session
      duplicated in both, one session selected in the non-focused window -- asserts exactly 8
      reaps (one per session), zero spawns/reattaches, and every survivor is the selected one (or
      lowest-index window for the rest) in a SINGLE tick. This is the scenario the task flagged
      as highest-scrutiny (it runs against Zac's actual live setup on activation) -- verified pure
      or not at all, no live run performed.
- [x] Registry: `WorkspaceRef.cmuxWindowId` (tmux-sourced refs only, stamped by partition-mode
      reconcile) and `.placementOverride` (ext-reported, via `groupPlacement`); `windowPairings:
      Map<cmuxWindowId, chromeWindowId>` + `setWindowPairing`/`homeChromeWindowId`; both new ref
      fields flow through `upsert`'s `changed` check (a window move re-broadcasts) and are
      persisted in `registry.json` (`windowPairings` as a plain object), defensively backfilled
      for a pre-feature file. `clearAttached` also clears `placementOverride` ("override clears
      with detach").
- [x] `server.ts`: `homeChromeWindowId`/`placementOverride` spread onto sync/state workspace
      objects AND `open_url` events at serialization time -- deliberately following the exact
      same pattern as `ports` (computed from the raw snapshot, never added to the core
      `ActuatorWorkspace` type or to `group-projection.ts`'s identity/dedup logic; see
      docs/protocol.md's new "Implementation notes" for why this made a planned
      `group-projection.ts` extension unnecessary). New ext->daemon frames `groupPlacement`
      (in the original contract) and `windowPairing` (my own addition -- the contract specifies
      only the persisted map and "resolved by marker tab", not how the daemon learns a pairing;
      this is that reporting frame, shaped like `groupPlacement`).
- [x] `main.ts`: `pollTmux` branches to `partition` mode (fetches `focusedWindowId` alongside
      windows/tabs); new `handleGroupPlacement`/`handleWindowPairing` wired into `server.ts`'s
      new callbacks, resolving wire identity -> real ref via the same
      `groupProjection.resolveIdentityToWorkspaceId()` pattern as every other ext->daemon frame;
      `hydrateRegistry`/`serializeRegistry` extended for the new persisted fields.
- [x] Config: `tmux.mirror` gains `"partition"` (config.ts type/validation/CLI validation), and
      it's the new DEFAULT (`DEFAULT_CONFIG.tmux.mirror`). `tmux-source.ts`'s own (separate)
      `MirrorMode` type widened to match -- `TMUX_CMUX_MIRROR` env compat stays windows/global-only
      (the legacy tool never had a `"partition"` env value).
- [x] `docs/protocol.md` updated: Wire protocol section gains the two new frames and the
      `homeChromeWindowId`/`placementOverride` fields; "Window pairing" section gains an
      "Implementation notes" subsection covering every decision/deviation above.
- [x] `bun test`: 532 pass, 0 fail (up from 502 at the start of this round). `bunx tsc --noEmit`:
      clean.
- **Not activated live.** `config.tmux.enabled` still defaults `false`, so this round changes
  nothing for anyone not already running the tmux absorption live. For an EXISTING
  `tmux.enabled: true` config with no explicit `tmux.mirror`, the new `"partition"` default takes
  effect on the next daemon restart/config reload and will immediately run the multi-window
  convergence reap against whatever real tmux/cmux state exists at that moment -- per the task's
  explicit instruction, this was not triggered here (same category of live/destructive action as
  the tmux cutover itself: a teammate's relayed "the user confirmed" is not the user's own
  authorization for reaping real tabs on Zac's live setup). To activate deliberately: either set
  `tmux.mirror: "partition"` explicitly (or leave it unset with `tmux.enabled: true` and restart/
  reload), from a moment where Zac is watching, since the very next `pollTmux` tick after the
  switch performs the one-time legacy convergence live.
- **Extension half needed next** (not started, out of this round's scope): per-window marker tab
  (`panel.html?win=<cmuxWindowId>`) to discover/create the paired Chrome window and report it via
  the new `windowPairing` frame; honoring `homeChromeWindowId` on group creation (`open_url`) and
  `placementOverride` on the janitor's cross-window recovery (skip overridden groups); sending
  `groupPlacement` when a `tabGroups.onCreated`-in-other-window move is observed with a managed
  title and no server-driven move marker; per-window activation/collapse scoping ("switching cmux
  tabs in window W activates/collapses groups ONLY within W's paired Chrome window").

## Isolated e2e regression triage + extension window-pairing half (2026-08-27 evening)

Priority insert ahead of the extension half: 3 isolated-e2e assertions were reported failing
against committed extension code (reproduced twice independently by team-lead). Systematic
debugging, then the extension window-pairing half per the daemon-half report's own spec.

### e2e triage findings

- **The named suspects are refuted by direct inspection.** `classifyJanitor(byId, groups,
  foreignGroups, crossWindowEnabled)` matches its call site exactly; same for
  `resolveGroupCache` and `chooseAdoptionWindow`. No signature mismatch exists anywhere in
  `e3b1bd7`'s janitor/window-split code.
- **Fixed a real structural bug regardless: `sw.js`'s `dispatchChain` could be permanently
  poisoned by one exception.** `(dispatchChain ?? Promise.resolve()).then(() =>
  dispatchNow(msg))` looks sequential but isn't failure-isolated -- once `dispatchNow` rejects
  once, every LATER `.then(dispatchNow)` on an already-rejected promise skips `dispatchNow`
  forever, silently freezing extension state for the rest of the service worker's lifetime. This
  is the best structural explanation for a 3-way co-occurring failure (one early rejection takes
  down everything after it) -- extracted the fix into a new pure, chrome-free module
  (`extension/chain.js`'s `chainStep`, isolates each step's failure the same way `executeOps`
  already isolates one bad op) since `sw.js` itself has top-level `chrome.*`/`boot()` side effects
  and isn't unit-testable directly. 5 new regression tests in `extension/test/chain.test.js`.
  Also added SW console/pageerror forwarding to `scripts/e2e-chromium.ts` (MV3 SW errors
  otherwise only show up in `chrome://extensions`, invisible to a scripted run).
- **Across 10 total e2e runs this round, this new forwarding never once caught an exception --
  including on runs where the exact 3-way failure reproduced.** This rules out an uncaught
  exception as the cause of what was actually observed, at least in every run I captured.
- **Root cause of the actual failures, captured directly in the daemon/extension logs**: the
  isolated e2e's daemon is isolated on port/state/config only -- it still tails Zac's REAL, live
  `events.jsonl` (explicit, deliberate, documented in the script's own header comment). Genuine
  concurrent cmux activity on his machine (multiple real `workspace.activated` events for
  unrelated titles like `cmux`/`amplify`, logged mid-test-run) races the test's tight assertion
  timing. Direct evidence: one failing run's janitor assertion read `count=3` (three groups
  sharing the test's title) where the test only ever creates one artificial duplicate --
  something else, concurrently, created another real group under the same title mid-test. This
  reproduces and clears intermittently as Zac's own foreground activity does; it is not a latent
  code defect this round's changes could fix. `reduceActivated`'s entry-creation (the specific
  mechanism behind the byId-pruning assertion) is documented, intentional behavior from `a6cf076`
  -- two commits before `e3b1bd7` -- confirmed via `git log -S`; not touched.
- **Not done**: hardening the e2e itself against this known non-isolation (e.g., a poll/retry
  window before each assertion, or briefly pausing the daemon's tail during the critical section)
  -- flagged as a follow-up, not attempted this round.
- [x] `bun test`: 689 pass, 0 fail (daemon + extension combined, up from 502+87 at session start
      counting only this task's own additions). `bunx tsc --noEmit`: clean (excluding pre-existing
      `extension/automation.js` errors from a concurrent, unrelated agent's uncommitted work).

### Extension window-pairing half

Per the daemon-half report's own spec, layered strictly ON TOP of today's single-window model --
the acceptance criterion throughout: a `cmuxWindowId: null` identity (every cmux-sourced
identity, and every tmux session in legacy windows/global mirror mode) behaves EXACTLY as before
this feature existed. Verified: the full 96-test extension suite and the isolated e2e (every
identity there is cmux-sourced) both stayed green through every change.

- **Daemon wire gap found and fixed first** (advisor-caught, before any extension code): the
  sync/state/`open_url` wire only carried `homeChromeWindowId`/`placementOverride`, never the
  raw `cmuxWindowId` backing them. Since a pairing can only be ESTABLISHED by the extension
  creating a marker tab at `panel.html?win=<cmuxWindowId>` -- which requires knowing the uuid
  first -- the daemon had no way to ever teach the extension a cmux window's id, so
  `windowPairings` could never be populated. Fixed: `cmuxWindowId` now spreads alongside the
  other two, same representative-member pattern, same three call sites (`server.ts`). Documented
  as a contract correction in `docs/protocol.md`.
- `reducer.js` (pure): `WorkspaceEntry` gains `cmuxWindowId`/`homeChromeWindowId`/
  `placementOverride` (decimal-string wire convention for the two Chrome-window ids; cmux ids are
  genuine UUID strings), read via a new `resolveWindowFields` helper (same "present > existing >
  default" shape as the existing `resolvePorts`). New exported `targetWindowFor(entry, state)`:
  `placementOverride` > `homeChromeWindowId` > `state.windowId` (the legacy single metamux
  window) -- this last fallback is the load-bearing null-safety guarantee. `ensureGroup`/
  `openUrl`/`collapseOthers` ops now carry an explicit resolved `windowId` (+ `cmuxWindowId` for
  on-demand pairing creation); `activate`/`archiveGroup` untouched (chrome APIs are window-
  agnostic given a real groupId/tabId). TDD: dedicated `targetWindowFor` describe block plus
  every existing op-shape fixture updated for the new fields.
- `chrome-ops.js` (glue): new `resolveTargetWindow(op, ctx)` -- uses `op.windowId` when resolved;
  when null but `op.cmuxWindowId` isn't, creates a fresh unfocused Chrome window + per-window
  marker tab and reports the pairing via a new `windowPairing` frame (not itself part of the
  original contract text, which specifies only the persisted map and "resolved by marker tab" --
  this is the reporting mechanism that flow needs); else falls back to `ctx.windowId` (legacy,
  unchanged). `ensureGroup`/`openUrl` route through it. `collapseOthers` reuses the reducer's own
  `targetWindowFor` (imported, same precedent as already importing `resolveGroupCache`/
  `chooseAdoptionWindow`) to scope collapse to the activated identity's own window -- inert
  (collapses everything, exactly as before) whenever no identity anywhere has a pairing.
  `resolveMetamuxWindow`'s marker scan now excludes `?win=` per-window pairing markers from
  `chooseAdoptionWindow`'s single-legacy-window consolidation -- without this, the first
  per-window marker this feature ever creates would get swept up and closed as a "duplicate."
- **Known incomplete, explicitly out of this round's scope** (documented here rather than
  silently shipped as done): (1) `watchTabActivation`/`watchGroupRemoved` are still scoped to the
  single legacy `windowId` -- F9 reverse sync and detach-on-close don't yet fire for a group
  living in a per-window-paired Chrome window. (2) `classifyJanitor`'s cross-window recovery
  logic is still single-window-canonical (one canonical group per TITLE, not per
  title-and-target-window) -- it hasn't been taught to distinguish "foreign because of a window
  split" from "foreign because of a legitimate `placementOverride`," so the contract's
  fresh-boot "adopt reality as override" rule isn't implemented. (3) Boot-time reconciliation of
  a per-window marker that already exists in Chrome but isn't yet in the daemon's
  `windowPairings` (e.g., a wiped registry.json) isn't implemented -- not load-bearing for the
  common case (the daemon persists `windowPairings` across restarts already), but a resilience
  gap for that edge case.
- [x] `bun test`: 689 pass, 0 fail. `bunx tsc --noEmit`: clean.
- **Not activated live** for the same reason as the daemon half: `config.tmux.enabled` still
  defaults false, and even where true, `cmuxWindowId` is only ever stamped by partition-mode
  reconcile, which itself is not yet live-activated (see above).

## Blockers

- tmux absorption live cutover (kill the real tmux-cmux-sync process, edit real `.zshrc`,
  restart the real daemon against Zac's live tmux/cmux state) needs Zac's direct go-ahead --
  see "tmux absorption -- code complete, LIVE CUTOVER NOT PERFORMED" above. Everything else on
  `tmux-absorption` is done, tested, and ready to execute against.
- Window pairing (partition model) live activation (see above) -- an EXISTING `tmux.enabled: true`
  config's next restart/reload now defaults to `"partition"` and performs a one-time multi-window
  convergence reap against real state; needs Zac watching when it happens, same category as the
  tmux cutover itself.

## Final activation (2026-08-27 ~19:05 UTC)

Partition convergence activated live: 6 mirror-era duplicate tabs reaped, verified 7 tmux
sessions = 7 cmux tabs (window 0: 6, window 1: 1), all tmux clients alive. README rewritten
to current reality + future roadmap. Remaining user step: ONE extension reload activates
window pairing + automation + all extension-side work. Known gaps listed in README.

## Placement following (2026-08-27 evening, finishing round)

Zac hit the flagged gap live: he manually moved a paired window's groups into a second Chrome
window by hand and auto-switching stopped for them. Root cause: `resolveGroupCache` only ever
compared a cached groupId against ONE legacy window and nulled anything else -- a real move
looked identical to "this group is gone" to it. This round resolves "Known incomplete" items
(1) and (2) from the window-pairing-half entry above.

- [x] `reducer.js`'s `resolveGroupCache(byId, state, allGroups)` (signature changed from
      `(byId, windowId, allGroups)`): resolves each entry against ITS OWN `targetWindowFor`
      instead of one global window. A cached groupId that still exists anywhere is authoritative
      regardless of window -- a move is reported (`placementObserved`), never invalidated. Title
      fallback now searches every window too: found at target, plain correction; found
      elsewhere, correction + `placementObserved` -- the contract's "adopt reality" fresh-boot
      rule.
- [x] New local fact `placementObserved` + op `reportGroupPlacement`: sets `placementOverride`
      optimistically, sends the existing `groupPlacement` frame (daemon-side handling untouched
      -- confirmed already correct from the prior round).
- [x] `chrome-ops.js`'s `watchGroupRemap` replaced by `watchGroupPlacement`: listens to BOTH
      `tabGroups.onCreated` and `onMoved` (Chrome's cross-window move mechanics aren't
      consistent) across ALL windows, debounced, reruns the same boot-time decision live.
      `watchGroupRemoved` no longer filters to one window and no longer assumes every removal is
      a close -- waits a beat and re-checks by title before concluding a group is really gone
      (no atomic Chrome signal distinguishes "moved" from "closed" at the instant onRemoved
      fires). `watchTabActivation` (F9) no longer filters to one window either.
- [x] `classifyJanitor`'s cross-window recovery now skips any title with an active
      `placementOverride` -- resolves "Known incomplete" item (2) from the daemon-half entry.
- [x] TDD: `resolveGroupCache`'s whole describe block rewritten for the new signature/behavior;
      new "placement following: the exact live case" describe block reproduces Zac's report end
      to end (move to window B -> override recorded -> activation + collapseOthers scoping both
      target it there, immediately, no waiting for cross-window recovery); new janitor
      override-skip regression test.
- **Still known incomplete** (unchanged, out of this round's scope too): the janitor's own
  duplicate-MERGING scan (`janitorGroups`/`scanTabGroups`) stays scoped to the single legacy
  window, not per-paired-window -- a genuine duplicate spanning two non-legacy windows isn't
  resolved by this round either (a coincidental same-titled group elsewhere is left alone, not
  merged, once the real cached groupId is found to still exist). Boot-time reconciliation of a
  per-window marker that exists in Chrome but isn't yet in `windowPairings` (item 3 from the
  daemon-half entry) also remains unimplemented.
- [x] `bun test`: 711 pass, 0 fail (up from 689 at the start of this round). `bunx tsc --noEmit`:
      clean (excluding pre-existing `extension/automation.js` errors, not mine).
- Staged via explicit paths (`extension/reducer.js`, `extension/chrome-ops.js`, `extension/sw.js`,
  `extension/test/reducer.test.js`, `docs/protocol.md`, this file) -- daemon-builder's concurrent
  WIP (`daemon/src/main.ts`, `daemon/src/server.ts`, `daemon/src/backflow-failure-tracker.ts`,
  new automation-crash-safety/backflow-failure-tracker tests) intentionally left untouched.

## Link routing: metamux-opener (2026-08-27, daemon-builder)

- [x] `opener/metamux-opener.swift` (single file, no Xcode project): LSUIElement app,
      registers http/https URL events, captures frontmost bundle id before anything steals
      focus, routes `com.cmuxterm.app` -> `POST /open` (1s timeout, port/secret read fresh
      per event), everything else (daemon down, non-2xx, other frontmost app) -> passthrough
      to Chrome explicitly (never the OS default handler -- that's ourselves, infinite loop).
      `--register` (LSSetDefaultHandlerForURLScheme, real user-click dialog) and `--test
      <cmux|passthrough> <url>` (forces each branch, no real frontmost-app control needed).
- [x] `scripts/install-opener.sh`: swiftc-compiles, assembles the .app bundle + Info.plist
      (CFBundleURLTypes for http/https), ad-hoc code-signs, lsregisters. Does NOT call
      `--register` itself -- flipping the default browser is Zac's own deliberate click.
- [x] Built + installed live at `~/Applications/metamux-opener.app`; both branches verified
      for real: `--test cmux` landed a live tab in the daemon's active workspace group
      (`/status` stayed healthy throughout, also re-confirming this round's crash-safety fix
      held under real load); `--test passthrough` opened Chrome directly.
- [x] `metamux open --active` CLI flag (`cli/open-args.ts`, pure, TDD'd, 5 tests): targets the
      daemon's active workspace explicitly (omits `cmuxWorkspaceId`) regardless of
      `$CMUX_WORKSPACE_ID` -- what metamux-opener's cmux branch relies on.
- [x] Decision table documented in docs/protocol.md ("Link routing") rather than mirrored as
      an untested TS module -- Swift isn't in this repo's test rig, and duplicating two
      branches as a disconnected TS copy would test the copy, not the real behavior.
- [x] README "Link routing" section + Setup step 4 + `--active` in the CLI table.
- [x] `bun test`: 716 pass, 0 fail. `bunx tsc --noEmit`: clean.
