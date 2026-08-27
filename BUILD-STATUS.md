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

## Blockers

None.
