// Daemon entrypoint. Subcommands: default/`run` (seed + tail, persist on
// every applied event), `doctor` (replay last 200 real events, no side
// effects).

import { appendFile } from "node:fs/promises";
import { loadCmuxNamedColorSlots } from "./cmux-config.ts";
import * as cmuxRpc from "./cmux-rpc.ts";
import { diffConfig } from "./config-diff.ts";
import { ConfigWatcher } from "./config-watch.ts";
import { loadConfig } from "./config.ts";
import { Gate, type GateEmission } from "./gate.ts";
import { GroupProjection } from "./group-projection.ts";
import { LazyGroupTracker } from "./lazy-groups.ts";
import { parseLine, parseWindowFocusedLine, type CmuxWorkspaceEvent } from "./parser.ts";
import { atomicWriteJson, CONFIG_PATH, cursorPath, ensureSecret, ensureStateDir, logPath, registryPath } from "./paths.ts";
import { PortsTracker } from "./ports.ts";
import { colorFor, Registry, type ActuatorEvent, type WorkspaceRef } from "./registry.ts";
import { shouldReverseSyncSelect } from "./reverse-sync.ts";
import { ActuatorServer } from "./server.ts";
import { Tailer } from "./tail.ts";

const PORTS_POLL_INTERVAL_MS = 4000;

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

function hydrateRegistry(
  saved: { workspaces: WorkspaceRef[]; activeId: string | null } | null,
  namedSlots: Record<string, string> | null,
): Registry {
  const registry = new Registry(namedSlots);
  if (!saved) return registry;
  for (const ref of saved.workspaces ?? []) {
    // registry.json written before this feature has no cmuxColor field.
    registry.workspaces.set(ref.id, { ...ref, cmuxColor: ref.cmuxColor ?? null });
  }
  registry.activeId = saved.activeId ?? null;
  return registry;
}

function serializeRegistry(registry: Registry) {
  return { workspaces: [...registry.workspaces.values()], activeId: registry.activeId };
}

async function runDaemon(): Promise<void> {
  await ensureStateDir();
  const config = await loadConfig();
  const secret = await ensureSecret();

  const cursor = await readJsonOrDefault<CursorState>(cursorPath(), DEFAULT_CURSOR);
  const savedRegistry = await readJsonOrDefault<{ workspaces: WorkspaceRef[]; activeId: string | null } | null>(
    registryPath(),
    null,
  );
  // Named cmux.json workspaceColors slots (e.g. "Blue" -> "#2779FB"), for
  // resolving set_color events that used a slot name instead of raw hex.
  // Plain local file read -- doesn't need socket features.
  const namedColorSlots = await loadCmuxNamedColorSlots();
  const registry = hydrateRegistry(savedRegistry, namedColorSlots);

  const stats = { skippedLines: 0 };

  const log = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(stamped);
    void appendFile(logPath(), stamped + "\n").catch(() => {});
  };

  // Socket-gated features (Phase 2): ports watcher, reverse sync, window
  // follow all need a cmux-spawned shell's env. Probe once at startup.
  const socketFeaturesEnabled = await cmuxRpc.probeSocketFeatures();
  log(
    socketFeaturesEnabled
      ? "socket features enabled ✓"
      : "socket features disabled (start the daemon from a cmux shell to enable)",
  );

  const portsTracker = socketFeaturesEnabled ? new PortsTracker() : undefined;

  // groupBy (title-aliasing) and createGroups (lazy inclusion) both live
  // here so main.ts's reverse-sync resolution and server.ts's broadcast/
  // buildSync/getState share the exact same projection state.
  const groupProjection = new GroupProjection(config.groupBy);
  const lazyGroups = new LazyGroupTracker();

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
    log,
  });
  server.start();

  const handleUserActivatedGroup = async (id: string): Promise<void> => {
    const snapshot = { workspaces: [...registry.workspaces.values()], activeId: registry.activeId };
    const eligible = shouldReverseSyncSelect({
      reverseSyncEnabled: config.reverseSync,
      socketFeaturesEnabled,
      requestedId: id,
      activeId: groupProjection.currentActiveIdentity(snapshot),
    });
    if (!eligible) return;
    const targetWorkspaceId = groupProjection.resolveIdentityToWorkspaceId(id, snapshot);
    if (!targetWorkspaceId) return;
    const ref = registry.workspaces.get(targetWorkspaceId);
    if (!ref) return;
    const result = await cmuxRpc.selectWorkspace(ref.sourceId);
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
      if (change.key === "collapseOthers" || change.key === "closeBehavior" || change.key === "groupBy" || change.key === "createGroups") {
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
    }
    if (changes.some((c) => c.hotApplicable && c.key === "createGroups")) config.createGroups = newConfig.createGroups;
    if (changes.some((c) => c.hotApplicable && c.key === "ports.mode")) config.ports.mode = newConfig.ports.mode;
    if (changes.some((c) => c.hotApplicable && c.key === "ports.ignore")) config.ports.ignore = newConfig.ports.ignore;
    if (changes.some((c) => c.hotApplicable && c.key === "ports.maxPort")) config.ports.maxPort = newConfig.ports.maxPort;

    if (extensionAffected) server.pushSyncToAll();
  };
  const configWatcher = new ConfigWatcher(CONFIG_PATH, config);

  const persist = async () => {
    await atomicWriteJson(registryPath(), serializeRegistry(registry));
    await atomicWriteJson(cursorPath(), cursor);
  };

  const applyAndMaybeEmit = (event: CmuxWorkspaceEvent, emit: boolean) => {
    const derived = registry.applyEvent(event);
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
    const current = await cmuxRpc.getCurrentWorkspace();
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
  // custom_color and apply it once, post-seed.
  if (socketFeaturesEnabled) {
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
  }

  // Live tail from here on.
  tailer.start((lines) => {
    for (const line of lines) {
      processLine(line, true, socketFeaturesEnabled);
    }
    scheduleLivePoll();
    void persist();
  });

  if (socketFeaturesEnabled) {
    portsPollTimer = setInterval(() => {
      void pollPorts();
    }, PORTS_POLL_INTERVAL_MS);
  }

  configWatcher.start(applyConfigChanges);

  const shutdown = async () => {
    tailer.stop();
    configWatcher.stop();
    if (pendingTimer) clearTimeout(pendingTimer);
    if (portsPollTimer) clearInterval(portsPollTimer);
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
  const registry = new Registry(namedColorSlots);
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
