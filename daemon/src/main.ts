// Daemon entrypoint. Subcommands: default/`run` (seed + tail, persist on
// every applied event), `doctor` (replay last 200 real events, no side
// effects).

import { appendFile } from "node:fs/promises";
import * as cmuxActuator from "./cmux-actuator.ts";
import { BackflowFailureTracker } from "./backflow-failure-tracker.ts";
import { loadCmuxNamedColorSlots } from "./cmux-config.ts";
import { computeBackflowCandidates, planBackflow, type BackflowRef } from "./color-backflow.ts";
import * as cmuxRpc from "./cmux-rpc.ts";
import { diffConfig } from "./config-diff.ts";
import { WindowSource } from "./window-source.ts";
import { ConfigWatcher } from "./config-watch.ts";
import { loadConfig } from "./config.ts";
import { Gate, type GateEmission } from "./gate.ts";
import { GroupProjection } from "./group-projection.ts";
import { LazyGroupTracker } from "./lazy-groups.ts";
import { loadPalette, type PaletteEntry } from "./palette.ts";
import { parseLine, parseWindowFocusedLine, type CmuxWorkspaceEvent } from "./parser.ts";
import { atomicWriteJson, CONFIG_PATH, cursorPath, ensureSecret, ensureStateDir, logPath, registryPath } from "./paths.ts";
import { PortsTracker } from "./ports.ts";
import { colorFor, Registry, type ActuatorEvent, type WorkspaceRef } from "./registry.ts";
import { shouldReverseSyncSelect } from "./reverse-sync.ts";
import { ActuatorServer } from "./server.ts";
import { SocketHealthMonitor } from "./socket-health.ts";
import { Tailer } from "./tail.ts";
import * as tmuxSource from "./tmux-source.ts";
import { loadLegacyState, planMigration } from "./tmux-migration.ts";
import {
  emptyReconcileState,
  reconcile,
  type CmuxActuatorAction,
  type ReconcileInput,
  type ReconcileState,
} from "./tmux-reconcile.ts";

const PORTS_POLL_INTERVAL_MS = 4000;
const SOCKET_PROBE_INTERVAL_MS = 30_000;
const TMUX_POLL_INTERVAL_MS = 2000; // matches tmux-cmux-sync's own TMUX_CMUX_INTERVAL default
const COLOR_BACKFLOW_INTERVAL_MS = 5000;
// A not_found paint failure archives its ref outright (definitive, no
// retries needed); anything else (a transient cmux CLI timeout/hiccup)
// gets this many consecutive tries before backflow gives up on that one
// target and stops hammering it every 5s -- see backflow-failure-tracker.ts.
const BACKFLOW_MAX_CONSECUTIVE_FAILURES = 3;

interface CursorState {
  bootId: string;
  seq: number;
}

const DEFAULT_CURSOR: CursorState = { bootId: "", seq: -1 };

async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return fallback;
    const text = await file.text();
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** True when this raw line's (boot_id, seq) is <= the persisted cursor,
 * i.e. it was already acted on in a previous run. Applies to every line
 * (not just workspace-category ones) since the cursor tracks stream
 * position, not just workspace events. */
function alreadyActedOn(rawBootId: string | null, rawSeq: number | null, cursor: CursorState): boolean {
  if (rawBootId === null || rawSeq === null) return false;
  return rawBootId === cursor.bootId && rawSeq <= cursor.seq;
}

function extractRawIdentity(line: string): { bootId: string | null; seq: number | null } {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const bootId = typeof obj.boot_id === "string" ? obj.boot_id : null;
    const seq = typeof obj.seq === "number" ? obj.seq : null;
    return { bootId, seq };
  } catch {
    return { bootId: null, seq: null };
  }
}

export function hydrateRegistry(
  saved: { workspaces: WorkspaceRef[]; activeId: string | null; windowPairings?: Record<string, string> } | null,
  namedSlots: Record<string, string> | null,
  palette: PaletteEntry[] = [],
): Registry {
  const registry = new Registry(namedSlots, palette);
  if (!saved) return registry;
  for (const ref of saved.workspaces ?? []) {
    // registry.json written before these features has no
    // cmuxColor/attachedAt/paintedColor/paletteIndex/cmuxWindowId/
    // placementOverride field.
    registry.workspaces.set(ref.id, {
      ...ref,
      cmuxColor: ref.cmuxColor ?? null,
      attachedAt: ref.attachedAt ?? null,
      paintedColor: ref.paintedColor ?? null,
      paletteIndex: ref.paletteIndex ?? null,
      cmuxWindowId: ref.cmuxWindowId ?? null,
      placementOverride: ref.placementOverride ?? null,
    });
  }
  registry.activeId = saved.activeId ?? null;
  for (const [cmuxWindowId, chromeWindowId] of Object.entries(saved.windowPairings ?? {})) {
    registry.setWindowPairing(cmuxWindowId, chromeWindowId);
  }
  return registry;
}

export function serializeRegistry(registry: Registry) {
  return {
    workspaces: [...registry.workspaces.values()],
    activeId: registry.activeId,
    windowPairings: Object.fromEntries(registry.windowPairings),
  };
}

async function runDaemon(): Promise<void> {
  await ensureStateDir();
  const config = await loadConfig();
  const secret = await ensureSecret();

  const cursor = await readJsonOrDefault<CursorState>(cursorPath(), DEFAULT_CURSOR);
  const savedRegistry = await readJsonOrDefault<{
    workspaces: WorkspaceRef[];
    activeId: string | null;
    windowPairings?: Record<string, string>;
  } | null>(
    registryPath(),
    null,
  );
  // Named cmux.json workspaceColors slots (e.g. "Blue" -> "#2779FB"), for
  // resolving set_color events that used a slot name instead of raw hex.
  // Plain local file read -- doesn't need socket features.
  const namedColorSlots = await loadCmuxNamedColorSlots();
  // Ordered brand palette (colorMode: "palette", palette.ts) -- same
  // read-once-at-startup lifecycle as namedColorSlots; a cmux.json edit
  // to workspaceColors.colors takes effect on the next restart.
  const palette = await loadPalette();
  const registry = hydrateRegistry(savedRegistry, namedColorSlots, palette);
  // Must be set before ANY applyEvent call, including the seed replay
  // below: replay pushes historical `selected` events through the
  // registry too, and attachOnActivate gates whether those re-stamp
  // attachedAt. Left at its default (true) this far, on-open would
  // silently degenerate back to attach-everything on every restart.
  registry.attachOnActivate = config.createGroups !== "on-open";
  registry.groupBy = config.groupBy;
  registry.colorMode = config.colorMode;
  // Repair pass for the 2026-08-27 duplication incident: collapse duplicate
  // live tmux refs before anything reads or extends the hydrated registry.
  const deduped = registry.dedupeTmuxRefs();

  const stats = { skippedLines: 0 };

  const log = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(stamped);
    void appendFile(logPath(), stamped + "\n").catch(() => {});
  };
  if (deduped.archived > 0) log(`registry repair: merged ${deduped.archived} duplicate tmux ref(s)`);

  // Process-level safety net (2026-08-27, incident: /automation testing
  // coincided with the daemon dying with no trace in daemon.log). Verified
  // directly: Bun.serve's `fetch:` callback safely catches a handler's
  // throw/rejection and turns it into a 500 -- but its `websocket.message`
  // callback does NOT; an uncaught exception there kills the WHOLE process
  // instantly, with no stack trace surviving into daemon.log (a native-
  // level abort, not a JS-catchable one from inside the handler). Any
  // "fire and forget" `void asyncFn()` poll-loop call (persist, backflow,
  // tmux reconcile, socket recovery -- all over this file) that rejects
  // without an internal .catch is the same class of risk: an unhandled
  // rejection. This is the deliberate, explicit fallback for whatever
  // throw site isn't (or can't be) hardened directly: log loudly and keep
  // running -- a daemon driving the user's live browser must degrade, not
  // die. It does NOT replace hardening a specific known-unsafe call site
  // (see handleWsMessage's own try/catch in server.ts); it's the net
  // underneath everything else.
  process.on("uncaughtException", (err) => {
    log(`[FATAL, CAUGHT] uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log(`[FATAL, CAUGHT] unhandledRejection: ${detail}`);
  });

  // Registry compaction (auto, startup-only): archived refs older than
  // config.pruneArchivedAfterDays are dropped before anything else touches
  // the registry (seed replay, lazy-tracker seeding). 0 disables this
  // entirely. A pruned ref's cmux workspace re-creates harmlessly if ever
  // seen again (registry.ts's pruneArchived) -- this only trims refs the
  // user is very unlikely to ever revisit, keeping sync/panel/janitor
  // scope from growing without bound across the daemon's lifetime.
  if (config.pruneArchivedAfterDays > 0) {
    const cutoff = new Date(Date.now() - config.pruneArchivedAfterDays * 24 * 60 * 60 * 1000).toISOString();
    const autoRemoved = registry.pruneArchived(cutoff);
    if (autoRemoved.length > 0) {
      log(
        `[prune] auto-compacted ${autoRemoved.length} archived workspace(s) older than ${config.pruneArchivedAfterDays}d: ${autoRemoved.map((r) => r.title).join(", ")}`,
      );
    }
  }

  // Socket-gated features (Phase 2): ports watcher, reverse sync, window
  // follow all need a cmux-spawned shell's env. Probed at startup, then
  // kept live: metamuxd is long-lived (zshrc-ensured), so a later cmux
  // restart must not leave these silently dead for the rest of the
  // process's life (docs/tmux-port-plan.md §2.7). socketHealth.getState()
  // is the live source of truth from here on -- every gate below reads it
  // fresh, not a frozen startup boolean.
  const initialProbe = await cmuxRpc.probeSocketFeatures();
  const socketHealth = new SocketHealthMonitor(initialProbe ? "enabled" : "disabled");
  log(
    initialProbe
      ? "socket features enabled ✓"
      : "socket features disabled (start the daemon from a cmux shell to enable)",
  );

  // Space-based cmux <-> Chrome window pairing. Needs no cmux socket and no TCC
  // grant, so it runs regardless of socket-feature state. If the helper cannot
  // run at all, pairing simply stays unhealthy and every caller keeps using
  // marker-tab identity.
  const repoDir = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const windowSource = new WindowSource(repoDir, logPath().replace(/\/[^/]+$/, ""), log);
  if (config.windowPairing.enabled) {
    windowSource.start();
    log(`[window-pairing] engine on ${JSON.stringify(config.windowPairing)}`);
    log("[window-pairing] follow-tab/auto-create/park await the extension half; engine observes only");
  } else {
    log("[window-pairing] disabled by config");
  }

  // Tied to the INITIAL probe, not the live state: if the daemon starts
  // enabled and cmux later restarts, this instance persists and simply
  // resumes polling once pollPorts() sees socketHealth recover -- no need
  // to reconstruct it. If the daemon starts disabled (no cmux shell at
  // all), ports stays unavailable even after a later recovery; the
  // realistic "cmux restarted under a long-running daemon" case this
  // round targets always starts enabled.
  const portsTracker = initialProbe ? new PortsTracker() : undefined;

  // Shared by every socket-dependent call site (reverse sync's
  // workspace.select, the ports poll's getCurrentWorkspace) so a run of
  // FAILURE_THRESHOLD consecutive failures trips the breaker exactly once,
  // regardless of which call site hit it.
  const reportSocketCallOutcome = (ok: boolean): void => {
    const transition = socketHealth.recordCallOutcome(ok);
    if (transition) {
      log("socket features lost (cmux restarted?); probing for recovery");
    }
  };

  // groupBy (title-aliasing) and createGroups ("on-open"/"on-activate"
  // lazy inclusion) both live here so main.ts's reverse-sync resolution
  // and server.ts's broadcast/buildSync/getState share the exact same
  // projection state.
  const groupProjection = new GroupProjection(config.groupBy, config.colorMode, palette);
  const lazyGroups = new LazyGroupTracker();

  // Seed lazy-inclusion attachment from registry.json's persisted
  // attachedAt fields -- otherwise every daemon restart would re-hide
  // every group in createGroups: "on-open"/"on-activate" mode until
  // re-attached, and the extension's offline-archive sync rule would then
  // collapse groups the user had open. A restart should not reshuffle the
  // browser.
  {
    const seedSnapshot = { workspaces: [...registry.workspaces.values()], activeId: registry.activeId };
    lazyGroups.seedFromRefs(seedSnapshot.workspaces, (ref) => groupProjection.identityFor(ref, seedSnapshot).id);
  }

  const server = new ActuatorServer({
    port: config.port,
    secret,
    registry,
    config,
    cursor,
    stats,
    groupProjection,
    lazyGroups,
    portsTracker,
    onUserActivatedGroup: (id) => {
      void handleUserActivatedGroup(id);
    },
    onUserClosedGroup: (id) => {
      handleUserClosedGroup(id);
    },
    onGroupPlacement: (id, chromeWindowId) => {
      handleGroupPlacement(id, chromeWindowId);
    },
    onWindowPairing: (cmuxWindowId, chromeWindowId) => {
      handleWindowPairing(cmuxWindowId, chromeWindowId);
    },
    onPrune: () => persist(),
    log,
  });
  server.start();

  // Detach-on-close: the user closed a managed Chrome group by hand.
  // Clears attachedAt for every real workspace composing the wire
  // identity (registry + in-memory lazyGroups), so future syncs stop
  // including it until it's reopened. The underlying workspace itself
  // stays live/unarchived -- this only un-attaches its group.
  const handleUserClosedGroup = (id: string): void => {
    const snapshot = { workspaces: [...registry.workspaces.values()], activeId: registry.activeId };
    const memberIds = groupProjection.membersOf(id, snapshot);
    if (memberIds.length === 0) return;
    for (const memberId of memberIds) registry.clearAttached(memberId);
    lazyGroups.clearAttached(id);
    log(`[detach] ${id} closed by user, cleared attachment for ${memberIds.length} workspace(s)`);
    void persist();
  };

  // Placement ownership (docs/protocol.md, "Placement ownership"): the
  // user moved a group's Chrome window by hand (or it returned home,
  // chromeWindowId: null). `id` is a wire identity (an alias in groupBy:
  // "title", a real workspace id in "workspace") -- resolved to the real
  // ref the same way every other ext->daemon frame resolves identity
  // (F9 reverse sync, detach-on-close).
  const handleGroupPlacement = (id: string, chromeWindowId: string | null): void => {
    const snapshot = { workspaces: [...registry.workspaces.values()], activeId: registry.activeId };
    const targetWorkspaceId = groupProjection.resolveIdentityToWorkspaceId(id, snapshot);
    if (!targetWorkspaceId) return;
    const derived = registry.setPlacementOverride(targetWorkspaceId, chromeWindowId);
    if (derived.length === 0) return;
    server.broadcast(derived);
    log(`[placement] ${id} -> ${chromeWindowId ?? "home"}`);
    void persist();
  };

  // Chrome window pairing (docs/protocol.md, "Chrome window pairing"): the
  // extension resolved (or created) the paired Chrome window for a cmux
  // window via its per-window marker tab. Pushes a fresh sync afterward --
  // homeChromeWindowId is computed at serialization time (server.ts), not
  // carried by individual broadcast events, so a pairing change needs an
  // explicit sync to reach already-connected clients.
  const handleWindowPairing = (cmuxWindowId: string, chromeWindowId: string): void => {
    registry.setWindowPairing(cmuxWindowId, chromeWindowId);
    log(`[windowPairing] ${cmuxWindowId} -> ${chromeWindowId}`);
    server.pushSyncToAll();
    void persist();
  };

  const handleUserActivatedGroup = async (id: string): Promise<void> => {
    const snapshot = { workspaces: [...registry.workspaces.values()], activeId: registry.activeId };
    const eligible = shouldReverseSyncSelect({
      reverseSyncEnabled: config.reverseSync,
      socketFeaturesEnabled: socketHealth.getState() === "enabled",
      requestedId: id,
      activeId: groupProjection.currentActiveIdentity(snapshot),
    });
    if (!eligible) return;
    const targetWorkspaceId = groupProjection.resolveIdentityToWorkspaceId(id, snapshot);
    if (!targetWorkspaceId) return;
    const ref = registry.workspaces.get(targetWorkspaceId);
    if (!ref) return;
    const result = await cmuxRpc.selectWorkspace(ref.sourceId);
    reportSocketCallOutcome(result.ok);
    if (!result.ok) {
      log(`[reverseSync] workspace.select failed for ${ref.title} (${ref.id}): ${result.error}`);
    } else {
      log(`[reverseSync] workspace.select -> ${ref.title} (${ref.id})`);
    }
    // The resulting workspace.selected event flows back through the normal
    // tail/parser/gate/registry pipeline -- no direct registry mutation here.
  };

  const gate = new Gate(config.debounceMs, 500);
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let portsPollTimer: ReturnType<typeof setInterval> | null = null;

  // Moved ahead of applyConfigChanges (was originally defined further
  // down, alongside applyAndMaybeEmit) so the tmux.enabled hot-reload
  // path below can call runTmuxMigration, which needs it.
  const persist = async () => {
    await atomicWriteJson(registryPath(), serializeRegistry(registry));
    await atomicWriteJson(cursorPath(), cursor);
  };

  // One-time tmux state migration (docs/tmux-port-plan.md §3.1(b)/§5
  // Phase 5): reclassifies cmux tabs tmux-cmux-sync already created into
  // tmux-sourced refs, preserving their mw_ id (and Chrome group).
  // Idempotent -- Registry.reclassifyAsTmux/archiveBySourceId are no-ops
  // on a second run (the cmux ref's source is already "tmux" by then), so
  // this is safe to call on every startup AND every live tmux.enabled
  // false->true toggle, with no separate "already migrated" marker.
  // Socket-gated: needs both live cmux window/tab state and live tmux
  // session state to plan anything.
  const runTmuxMigration = async (): Promise<void> => {
    if (!config.tmux.enabled || socketHealth.getState() !== "enabled") return;
    const [legacy, sessions] = await Promise.all([loadLegacyState(), tmuxSource.listSessions()]);
    const sessionsByName = new Map(sessions.map((s) => [s.name, s.id] as const));
    const plan = planMigration(legacy, sessionsByName);
    if (plan.reclassify.length === 0 && plan.archive.length === 0) return;

    const derived: ActuatorEvent[] = [];
    for (const r of plan.reclassify) derived.push(...registry.reclassifyAsTmux(r.cmuxSourceId, r.sessionId, r.sessionName));
    for (const a of plan.archive) derived.push(...registry.archiveBySourceId(a.source, a.cmuxSourceId));
    if (derived.length > 0) {
      server.broadcast(derived);
      await persist();
      log(`[tmux migration] reclassified ${plan.reclassify.length}, archived ${plan.archive.length} legacy cmux ref(s)`);
    }
  };

  // Config hot-reload: menubar toggles apply without a daemon restart.
  // `config` is mutated in place (never reassigned) so every closure that
  // already captured it (server, pollPorts, the /focus & /open handlers)
  // sees hot-applied changes on its next read automatically. Only `gate`
  // holds its own private copy of debounceMs, hence the explicit setter.
  const applyConfigChanges = (newConfig: typeof config): void => {
    const changes = diffConfig(config, newConfig);
    if (changes.length === 0) return;

    let extensionAffected = false;
    for (const change of changes) {
      if (!change.hotApplicable) {
        log(`restart required for: ${change.key}`);
        continue;
      }
      log(`config reloaded: ${change.key} ${JSON.stringify(change.oldValue)} -> ${JSON.stringify(change.newValue)}`);
      if (
        change.key === "collapseOthers" ||
        change.key === "closeBehavior" ||
        change.key === "groupBy" ||
        change.key === "createGroups" ||
        change.key === "janitor" ||
        change.key === "janitorCrossWindow" ||
        change.key === "colorMode"
      ) {
        extensionAffected = true;
      }
    }

    if (changes.some((c) => c.hotApplicable && c.key === "reverseSync")) config.reverseSync = newConfig.reverseSync;
    if (changes.some((c) => c.hotApplicable && c.key === "collapseOthers")) config.collapseOthers = newConfig.collapseOthers;
    if (changes.some((c) => c.hotApplicable && c.key === "closeBehavior")) config.closeBehavior = newConfig.closeBehavior;
    if (changes.some((c) => c.hotApplicable && c.key === "debounceMs")) {
      config.debounceMs = newConfig.debounceMs;
      gate.setDebounceMs(newConfig.debounceMs);
    }
    if (changes.some((c) => c.hotApplicable && c.key === "groupBy")) {
      config.groupBy = newConfig.groupBy;
      groupProjection.setGroupBy(newConfig.groupBy);
      registry.groupBy = newConfig.groupBy;
    }
    if (changes.some((c) => c.hotApplicable && c.key === "createGroups")) {
      config.createGroups = newConfig.createGroups;
      registry.attachOnActivate = newConfig.createGroups !== "on-open";
    }
    if (changes.some((c) => c.hotApplicable && c.key === "ports.mode")) config.ports.mode = newConfig.ports.mode;
    if (changes.some((c) => c.hotApplicable && c.key === "ports.ignore")) config.ports.ignore = newConfig.ports.ignore;
    if (changes.some((c) => c.hotApplicable && c.key === "ports.maxPort")) config.ports.maxPort = newConfig.ports.maxPort;
    if (changes.some((c) => c.hotApplicable && c.key === "tmux.mirror")) config.tmux.mirror = newConfig.tmux.mirror;
    if (changes.some((c) => c.hotApplicable && c.key === "tmux.alphabetize")) config.tmux.alphabetize = newConfig.tmux.alphabetize;
    if (changes.some((c) => c.hotApplicable && c.key === "tmux.reattachGraceMs")) config.tmux.reattachGraceMs = newConfig.tmux.reattachGraceMs;
    if (changes.some((c) => c.hotApplicable && c.key === "tmux.spawnCwd")) config.tmux.spawnCwd = newConfig.tmux.spawnCwd;
    if (changes.some((c) => c.hotApplicable && c.key === "tmux.enabled")) {
      const wasEnabled = config.tmux.enabled;
      config.tmux.enabled = newConfig.tmux.enabled;
      // A live false->true toggle needs the same one-time migration a
      // fresh startup gets -- otherwise the next reconcile tick would
      // spawn duplicate tabs for sessions tmux-cmux-sync already mirrored.
      if (!wasEnabled && config.tmux.enabled) void runTmuxMigration();
    }
    if (changes.some((c) => c.hotApplicable && c.key === "colorBackflow")) config.colorBackflow = newConfig.colorBackflow;
    if (changes.some((c) => c.hotApplicable && c.key === "janitor")) config.janitor = newConfig.janitor;
    if (changes.some((c) => c.hotApplicable && c.key === "janitorCrossWindow")) config.janitorCrossWindow = newConfig.janitorCrossWindow;
    if (changes.some((c) => c.hotApplicable && c.key === "colorMode")) {
      config.colorMode = newConfig.colorMode;
      registry.colorMode = newConfig.colorMode;
      groupProjection.setColorMode(newConfig.colorMode);
    }
    if (changes.some((c) => c.hotApplicable && c.key === "agentBrowser")) config.agentBrowser = newConfig.agentBrowser;
    // Hot on purpose: windowPairing.enabled is the kill switch, and needing a
    // daemon restart to turn pairing off would defeat it.
    if (changes.some((c) => c.hotApplicable && c.key.startsWith("windowPairing."))) {
      config.windowPairing = newConfig.windowPairing;
      log(`[window-pairing] config -> ${JSON.stringify(newConfig.windowPairing)}`);
    }

    if (extensionAffected) server.pushSyncToAll();
  };
  const configWatcher = new ConfigWatcher(CONFIG_PATH, config);

  const applyAndMaybeEmit = (event: CmuxWorkspaceEvent, emit: boolean) => {
    const derived = registry.applyEvent(event);
    // An activation is the one moment a cmux window is guaranteed on screen,
    // which is what lets the pairing bind that window's UUID to a display.
    if (emit && event.name === "selected" && config.windowPairing.enabled) {
      const ref = registry.activeId ? registry.workspaces.get(registry.activeId) : null;
      if (ref?.cmuxWindowId) windowSource.pairing.noteActivation(ref.cmuxWindowId);
    }
    if (emit && derived.length > 0) server.broadcast(derived);
  };

  const handleEmission = (emission: GateEmission, emit: boolean) => {
    if (emission.kind === "dropped") return; // suppressed created->selected yank, no registry change
    applyAndMaybeEmit(emission.event, emit);
  };

  const scheduleLivePoll = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    const deadline = gate.nextDeadline();
    if (deadline === null) return;
    const delay = Math.max(0, deadline - Date.now());
    pendingTimer = setTimeout(() => {
      const flushed = gate.poll(Date.now());
      if (flushed) handleEmission(flushed, true);
      void persist();
      scheduleLivePoll();
    }, delay);
  };

  // F8 ports watcher: poll cmux's live notion of the active workspace
  // (not registry.activeId, which lags the JSONL tail) every 4s, diff via
  // PortsTracker, and act per config.ports.mode.
  const pollPorts = async (): Promise<void> => {
    if (!portsTracker) return;
    if (socketHealth.getState() !== "enabled") return;
    const current = await cmuxRpc.getCurrentWorkspace();
    reportSocketCallOutcome(current !== null);
    if (!current) return;

    let targetRef: WorkspaceRef | null = null;
    for (const ref of registry.workspaces.values()) {
      if (ref.sourceId === current.workspaceId) {
        targetRef = ref;
        break;
      }
    }
    if (!targetRef) return; // not yet known to the registry this run

    const { autoOpen, notifyOnly } = portsTracker.diff(current.workspaceId, current.listeningPorts, {
      ignore: config.ports.ignore,
      maxPort: config.ports.maxPort,
    });
    if (config.ports.mode === "off") return;

    if (config.ports.mode === "notify") {
      // notify mode never opens anything, so the auto-open cap is moot --
      // every fresh port (within the ephemeral cutoff) just gets logged.
      for (const port of [...autoOpen, ...notifyOnly]) {
        log(`[ports] new port ${port} on ${targetRef.title} (${targetRef.id}) -- http://localhost:${port}`);
      }
      return;
    }

    for (const port of autoOpen) {
      server.pushOpenUrl(targetRef, `http://localhost:${port}`);
    }
    for (const port of notifyOnly) {
      log(
        `[ports] new port ${port} on ${targetRef.title} (${targetRef.id}) -- http://localhost:${port} (per-cycle cap reached, not auto-opened)`,
      );
    }
  };

  // tmux source + cmux actuator (docs/tmux-port-plan.md §2): mirrors
  // tmux sessions into cmux tabs and registers them as tmux-sourced
  // WorkspaceRefs, replacing tmux-cmux-sync as one program instead of two.
  // `nextState` (windowAttachments/globalAttachments/reattachAttempts) is
  // this poller's own cache, analogous to registry.json for the main
  // registry -- rebuilt fresh from live tmux+cmux state every tick, never
  // persisted (a restart just re-derives it, same as tmux-cmux-sync.json
  // being a cache rather than a ledger).
  let tmuxReconcileState: ReconcileState = emptyReconcileState();

  // Color backflow's per-target consecutive-failure backoff (see
  // BACKFLOW_MAX_CONSECUTIVE_FAILURES above) -- never persisted, a
  // restart just starts every target with a clean slate.
  const backflowFailures = new BackflowFailureTracker(BACKFLOW_MAX_CONSECUTIVE_FAILURES);

  const executeTmuxAction = async (action: CmuxActuatorAction): Promise<void> => {
    switch (action.type) {
      case "spawn": {
        const result = await cmuxActuator.spawnTab({ windowId: action.windowId, sessionName: action.sessionName, cwd: action.cwd });
        reportSocketCallOutcome(result.ok);
        log(
          result.ok
            ? `[tmux] spawn ${action.sessionName} -> ${result.tabRef ?? "?"} (win ${action.windowId ?? "any"})`
            : `[tmux] spawn FAILED ${action.sessionName}: ${result.error}`,
        );
        break;
      }
      case "retitle": {
        const result = await cmuxActuator.retitleTab({ workspaceRef: action.workspaceRef, title: action.title });
        reportSocketCallOutcome(result.ok);
        if (result.ok) log(`[tmux] retitle ${action.workspaceRef} -> ${action.title}`);
        break;
      }
      case "reattach": {
        const result = await cmuxActuator.reattachTab({ workspaceRef: action.workspaceRef, sessionName: action.sessionName });
        reportSocketCallOutcome(result.ok);
        if (result.ok) log(`[tmux] reattach ${action.sessionName} -> ${action.workspaceRef}`);
        break;
      }
      case "reap": {
        const result = await cmuxActuator.closeTab(action.workspaceRef);
        reportSocketCallOutcome(result.ok);
        if (result.ok) log(`[tmux] reap ${action.workspaceRef}`);
        break;
      }
      case "reorder": {
        const result = await cmuxActuator.reorderTabs({ windowId: action.windowId, orderedWorkspaceRefs: action.orderedWorkspaceRefs });
        reportSocketCallOutcome(result.ok);
        if (result.ok) log(`[tmux] reorder win ${action.windowId}`);
        break;
      }
    }
  };

  // Socket-gated like pollPorts (window/tab listing and every actuator
  // action go through the cmux CLI, which needs the same auth); tmux-
  // source.ts itself has no such dependency, but there's nothing useful
  // to actuate with tmux state alone while cmux is unreachable. Runs
  // unconditionally on its own timer (like the socket recovery probe) so
  // config.tmux.enabled is truly hot-reloadable with no separate
  // start/stop wiring -- this function just early-returns when disabled.
  const pollTmux = async (): Promise<void> => {
    if (!config.tmux.enabled) return;
    if (socketHealth.getState() !== "enabled") return;

    const [sessions, hostMap, windows] = await Promise.all([tmuxSource.listSessions(), tmuxSource.hostMap(), cmuxActuator.listWindows()]);

    const reconcileConfig = {
      mirrorMode: config.tmux.mirror,
      alphabetize: config.tmux.alphabetize,
      reattachGraceMs: config.tmux.reattachGraceMs,
      spawnCwd: config.tmux.spawnCwd,
      now: Date.now(),
    };

    let input: ReconcileInput;
    if (config.tmux.mirror === "windows") {
      const windowsWithTabs = await Promise.all(
        windows.map(async (w) => ({ id: w.id, index: w.index, tabs: await cmuxActuator.listTabs(w.id) })),
      );
      input = { mode: "windows", sessions, hostMap, windows: windowsWithTabs, state: tmuxReconcileState, config: reconcileConfig };
    } else if (config.tmux.mirror === "partition") {
      const [windowsWithTabs, focusedWindowId] = await Promise.all([
        Promise.all(windows.map(async (w) => ({ id: w.id, index: w.index, tabs: await cmuxActuator.listTabs(w.id) }))),
        cmuxActuator.getFocusedWindowId(),
      ]);
      input = {
        mode: "partition",
        sessions,
        hostMap,
        windows: windowsWithTabs,
        focusedWindowId,
        state: tmuxReconcileState,
        config: reconcileConfig,
      };
    } else {
      const allTabs = (await Promise.all(windows.map((w) => cmuxActuator.listTabs(w.id)))).flat();
      input = { mode: "global", sessions, hostMap, allTabs, state: tmuxReconcileState, config: reconcileConfig };
    }

    const result = reconcile(input);
    tmuxReconcileState = result.nextState;

    const derived: ActuatorEvent[] = [];
    for (const intent of result.registryIntents) derived.push(...registry.applyTmuxIntent(intent));
    if (derived.length > 0) {
      server.broadcast(derived);
      void persist();
    }

    for (const action of result.actions) {
      await executeTmuxAction(action);
    }
  };

  // Color backflow (docs/protocol.md's "Color backflow" section): paints
  // a cmux tab's own color to match its Chrome group when that group's
  // color is the title-hash fallback -- never a user-set one. Socket-gated
  // like pollTmux (set-color goes through the cmux CLI); the decision
  // logic itself (color-backflow.ts) is pure, this is just the poll +
  // execute wrapper. Runs unconditionally on its own timer for the same
  // hot-reload reason pollTmux does.
  const pollColorBackflow = async (): Promise<void> => {
    if (!config.colorBackflow) return;
    if (socketHealth.getState() !== "enabled") return;

    const refs: BackflowRef[] = [...registry.workspaces.values()].map((ref) => ({
      id: ref.id,
      source: ref.source,
      sourceId: ref.sourceId,
      title: ref.title,
      cmuxColor: ref.cmuxColor,
      paintedColor: ref.paintedColor,
      paletteIndex: ref.paletteIndex,
      archived: ref.archived,
    }));
    const candidates = computeBackflowCandidates(refs, config.groupBy, config.colorMode, palette);
    // Skip a target that's already given up (backflow-failure-tracker.ts) --
    // a transient failure gets bounded retries, not hammered forever.
    const actions = planBackflow(candidates).filter((action) => !backflowFailures.isGivenUp(action.refId));
    if (actions.length === 0) return;

    let anyPainted = false;
    let anyArchived = false;
    for (const action of actions) {
      const result = await cmuxActuator.setTabColor({ workspaceRef: action.cmuxWorkspaceId, color: action.targetHex });
      reportSocketCallOutcome(result.ok);
      if (result.ok) {
        registry.markPainted(action.refId, action.targetHex);
        backflowFailures.recordSuccess(action.refId);
        anyPainted = true;
        log(`[color-backflow] painted ${action.cmuxWorkspaceId} -> ${action.targetHex}`);
        continue;
      }

      // not_found is DEFINITIVE proof the workspace no longer exists in
      // cmux -- not something a retry could ever fix. Archive it right
      // here rather than retrying: this is the self-healing half of the
      // fix (a stale ref that survives seed-replay resurrection -- e.g.
      // its close event fell before an events.jsonl rotation boundary --
      // stops getting targeted the moment backflow proves it's gone,
      // instead of retrying every 5s forever).
      if (result.error?.startsWith("not_found")) {
        const derived = registry.archiveBySourceId("cmux", action.cmuxWorkspaceId);
        backflowFailures.recordSuccess(action.refId); // no longer a live target -- nothing to back off
        anyArchived = derived.length > 0;
        if (derived.length > 0) {
          server.broadcast(derived);
          log(`[color-backflow] ${action.cmuxWorkspaceId} not_found -- archived (workspace no longer exists in cmux)`);
        }
        continue;
      }

      const outcome = backflowFailures.recordFailure(action.refId);
      if (outcome === "just-gave-up") {
        log(
          `[color-backflow] paint FAILED ${action.cmuxWorkspaceId} (${BACKFLOW_MAX_CONSECUTIVE_FAILURES} times in a row) -- giving up on this target: ${result.error}`,
        );
      } else if (outcome === "keep-retrying") {
        log(`[color-backflow] paint FAILED ${action.cmuxWorkspaceId}: ${result.error}`);
      } // "already-given-up" -- silent, already logged once above
    }
    if (anyPainted || anyArchived) void persist();
  };

  // F7 window follow (best effort, live-tail only -- see report for why
  // seeding is excluded): a window.focused line directly activates its
  // workspace, bypassing the normal upsert path since it carries no
  // title/cwd (see Registry.activateBySourceId).
  const processLine = (line: string, emitPhase: boolean, windowFollow: boolean): void => {
    const { bootId: rawBootId, seq: rawSeq } = extractRawIdentity(line);
    const event = parseLine(line);
    let handled = false;

    if (event) {
      handled = true;
      const emit = emitPhase && !alreadyActedOn(rawBootId, rawSeq, cursor);
      const emissions = gate.feed(event);
      for (const emission of emissions) handleEmission(emission, emit);
    } else if (windowFollow) {
      const windowEvent = parseWindowFocusedLine(line);
      if (windowEvent) {
        handled = true;
        const derived = registry.activateBySourceId(windowEvent.workspaceId);
        if (derived.length > 0) {
          server.broadcast(derived);
          log(`[window-follow] window ${windowEvent.windowId} -> workspace ${windowEvent.workspaceId}`);
        }
      }
    }

    if (!handled && rawBootId === null && rawSeq === null) {
      stats.skippedLines++;
    }

    if (rawBootId !== null && rawSeq !== null) {
      cursor.bootId = rawBootId;
      cursor.seq = rawSeq;
    }
  };

  // Seed: full read, replay in order. Cursor comparison suppresses
  // actuator emission for already-acted-on events; registry still updates.
  const tailer = new Tailer(config.eventsPath);
  const seedLines = await tailer.readAll();
  log(`tailing ${config.eventsPath} ✓`);

  for (const line of seedLines) {
    processLine(line, true, false); // window-follow is a live-only concern, see above
    // drive the gate's debounce off the event stream's own clock during
    // seeding -- there's no reason to wait real wall-clock ms for history.
    const parsedForClock = parseLine(line);
    if (parsedForClock) {
      const flushed = gate.poll(parsedForClock.occurredAtMs);
      if (flushed) handleEmission(flushed, true);
    }
  }
  // catch up any trailing pending debounce now that seeding is done
  const finalFlush = gate.poll(Date.now());
  if (finalFlush) handleEmission(finalFlush, true);

  await persist();

  const activeTitle = registry.activeId ? registry.workspaces.get(registry.activeId)?.title ?? "none" : "none";
  const archivedCount = [...registry.workspaces.values()].filter((r) => r.archived).length;
  log(`seeded ${registry.workspaces.size} workspaces (${archivedCount} archived), active: ${activeTitle}`);

  // Color backfill: set_color/clear_color only appear in the log from
  // whenever the daemon started tailing -- a color set before that never
  // shows up as an event. Ask cmux directly for every workspace's current
  // custom_color and apply it once, post-seed. Extracted into a function so
  // socket-recovery can re-run the same backfill (see trySocketRecovery
  // below) -- a cmux restart can leave colors set/changed while the socket
  // was down. Its outcome is NOT reported to the breaker: an empty result
  // is ambiguous (no workspace has a color set vs. the call failing), so
  // this call site can't distinguish "healthy but nothing to backfill" from
  // "unreachable" the way getCurrentWorkspace's null/non-null can.
  const runColorBackfill = async (): Promise<void> => {
    const colorSeeds = await cmuxRpc.listAllWorkspaceColors();
    const colorEvents: ActuatorEvent[] = [];
    for (const seed of colorSeeds) {
      colorEvents.push(...registry.applyColor(seed.sourceId, seed.customColor));
    }
    if (colorEvents.length > 0) {
      server.broadcast(colorEvents);
      await persist();
      log(`backfilled ${colorEvents.length} workspace color(s) from cmux`);
    }
  };
  if (initialProbe) await runColorBackfill();
  if (initialProbe) await runTmuxMigration();

  // Live tail from here on.
  tailer.start((lines) => {
    for (const line of lines) {
      processLine(line, true, socketHealth.getState() === "enabled");
    }
    scheduleLivePoll();
    void persist();
  });

  if (initialProbe) {
    portsPollTimer = setInterval(() => {
      void pollPorts();
    }, PORTS_POLL_INTERVAL_MS);
  }

  // Recovery: re-probe every 30s, but only actually make the RPC call while
  // disabled -- a healthy daemon should never pay for a probe it doesn't
  // need (docs/tmux-port-plan.md §2.7). Runs unconditionally (not gated on
  // initialProbe) so it also covers a daemon started outside a cmux shell
  // entirely, not just the "cmux restarted under a long-lived daemon" case.
  const trySocketRecovery = async (): Promise<void> => {
    if (socketHealth.getState() !== "disabled") return;
    const ok = await cmuxRpc.probeSocketFeatures();
    const transition = socketHealth.recordProbeOutcome(ok);
    if (transition) {
      log("socket features restored ✓");
      await runColorBackfill();
    }
  };
  const socketProbeTimer: ReturnType<typeof setInterval> = setInterval(() => {
    void trySocketRecovery();
  }, SOCKET_PROBE_INTERVAL_MS);

  // Unconditional, like socketProbeTimer -- pollTmux's own internal
  // config.tmux.enabled/socketHealth checks are what actually gate it, so
  // config.tmux.enabled stays hot-reloadable with no separate timer
  // start/stop dance.
  const tmuxPollTimer: ReturnType<typeof setInterval> = setInterval(() => {
    void pollTmux();
  }, TMUX_POLL_INTERVAL_MS);

  // Same unconditional-timer-with-internal-gate shape as tmuxPollTimer.
  const colorBackflowTimer: ReturnType<typeof setInterval> = setInterval(() => {
    void pollColorBackflow();
  }, COLOR_BACKFLOW_INTERVAL_MS);

  configWatcher.start(applyConfigChanges);

  const shutdown = async () => {
    tailer.stop();
    configWatcher.stop();
    if (pendingTimer) clearTimeout(pendingTimer);
    if (portsPollTimer) clearInterval(portsPollTimer);
    clearInterval(socketProbeTimer);
    clearInterval(tmuxPollTimer);
    clearInterval(colorBackflowTimer);
    await persist();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runDoctor(): Promise<void> {
  const config = await loadConfig();
  const tailer = new Tailer(config.eventsPath);
  const allLines = await tailer.readAll();
  const lines = allLines.slice(-200);

  console.log(`metamux doctor: replaying last ${lines.length} of ${allLines.length} lines from ${config.eventsPath}`);
  console.log("(no side effects -- registry.json/cursor.json are not touched)");

  const namedColorSlots = await loadCmuxNamedColorSlots();
  const palette = await loadPalette();
  const registry = new Registry(namedColorSlots, palette);
  registry.groupBy = config.groupBy;
  registry.colorMode = config.colorMode;
  const gate = new Gate(config.debounceMs, 500);
  let skipped = 0;
  let suppressedCount = 0;
  const createdAt = new Map<string, number>();
  const suppressionClusters: { workspaceId: string; gapMs: number }[] = [];

  const applyEmission = (emission: GateEmission) => {
    if (emission.kind === "dropped") {
      suppressedCount++;
      return;
    }
    const derived: ActuatorEvent[] = registry.applyEvent(emission.event);
    for (const d of derived) {
      console.log(`  [${d.name}] ${d.workspace.title} (${d.workspace.id}) color=${d.workspace.color}`);
    }
  };

  for (const line of lines) {
    let raw: Record<string, unknown> | null = null;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const event = parseLine(line);
    if (!event) continue;

    if (event.name === "created") {
      createdAt.set(event.workspaceId, event.occurredAtMs);
    }
    if (event.name === "selected") {
      const c = createdAt.get(event.workspaceId);
      if (c !== undefined && event.occurredAtMs - c >= 0 && event.occurredAtMs - c <= 500) {
        suppressionClusters.push({ workspaceId: event.workspaceId, gapMs: event.occurredAtMs - c });
      }
    }

    const emissions = gate.feed(event);
    for (const emission of emissions) applyEmission(emission);
    const flushed = gate.poll(event.occurredAtMs);
    if (flushed) applyEmission(flushed);
    void raw;
  }
  const finalFlush = gate.poll(Date.now());
  if (finalFlush) applyEmission(finalFlush);

  console.log("");
  console.log(`registry after replay: ${registry.workspaces.size} workspaces, activeId=${registry.activeId ?? "none"}`);
  console.log(`skipped lines (malformed JSON): ${skipped}`);
  console.log(`created->selected clusters within 500ms (would be suppressed): ${suppressionClusters.length}`);
  for (const c of suppressionClusters) {
    console.log(`  workspace ${c.workspaceId}: selected ${c.gapMs}ms after created`);
  }
  console.log(`selected events actually suppressed by the gate during replay: ${suppressedCount}`);

  console.log("");
  const socketFeaturesEnabled = await cmuxRpc.probeSocketFeatures();
  console.log(`socket features: ${socketFeaturesEnabled ? "enabled ✓" : "disabled (not running from a cmux shell)"}`);
  if (socketFeaturesEnabled) {
    const current = await cmuxRpc.getCurrentWorkspace();
    if (current) {
      const portsText = current.listeningPorts.length > 0 ? current.listeningPorts.join(", ") : "none";
      console.log(`current active workspace (live): ${current.title} (${current.workspaceId})`);
      console.log(`current listening ports: ${portsText}`);
    } else {
      console.log("current active workspace (live): unavailable (cmux rpc workspace.current failed)");
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "run";
  if (cmd === "doctor") {
    await runDoctor();
    return;
  }
  if (cmd === "run" || cmd === undefined) {
    await runDaemon();
    return;
  }
  console.error(`unknown command: ${cmd}`);
  console.error("usage: metamux-daemon [run|doctor]");
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { colorFor };
