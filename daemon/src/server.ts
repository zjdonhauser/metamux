// Bun.serve on 127.0.0.1:<port>: WS /actuator + HTTP POST /open, GET /status,
// GET /state, POST /focus, POST /prune. One port, per docs/protocol.md
// "Wire protocol" and "Phase 2 additions".
//
// Wire-projection layer: raw per-workspace registry state/events are
// projected through GroupProjection (groupBy: title-aliasing) and
// LazyGroupTracker (createGroups: "on-open"/"on-activate" lazy inclusion) before anything reaches
// a client. The Registry itself never sees either concern.

import type { Server, ServerWebSocket } from "bun";
import { lookup } from "node:dns/promises";
import { PendingRequestTable } from "./automation-rpc.ts";
import { toolAllowed } from "./automation-policy.ts";
import { decideNavigate } from "./navigate-gate.ts";
import type { MetamuxConfig } from "./config.ts";
import type { GroupProjection, GroupProjectionSnapshot } from "./group-projection.ts";
import type { LazyGroupTracker } from "./lazy-groups.ts";
import type { PortsTracker } from "./ports.ts";
import type { ActuatorEvent, ActuatorWorkspace, Registry, WorkspaceRef } from "./registry.ts";

const AUTOMATION_TIMEOUT_MS = 15000;

interface WsData {
  authed: boolean;
  client: string | null;
}

interface CursorState {
  bootId: string;
  seq: number;
}

/** One Chrome window as the extension sees it, in Chrome's own coordinates. */
export interface ChromeWindowBounds {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ServerStats {
  skippedLines: number;
}

type PushedEvent =
  | { type: "event"; seq: number; name: ActuatorEvent["name"]; workspace: ActuatorWorkspace }
  | {
      type: "event";
      seq: number;
      name: "move_group_to_window";
      /** The title alias, for logging and correlation. */
      id: string;
      /** chrome-ops resolves the group by title: a groupId does not survive a
       * cross-window move. */
      title: string;
      chromeWindowId: number;
    }
  | {
      type: "event";
      seq: number;
      name: "open_url";
      workspace: ActuatorWorkspace;
      url: string;
      /** Window pairing (docs/protocol.md, "Chrome window pairing"): the
       * Chrome window group creation should target, resolved at the exact
       * moment of open_url -- "Group creation (on-open) happens in the
       * home window, creating the paired Chrome window on demand
       * (focused:false) if absent." null when unresolvable (no cmux
       * window known yet, or the pair hasn't been created/reported) --
       * the extension falls back to its own current window in that case. */
      homeChromeWindowId: string | null;
      /** The raw cmux window id backing `homeChromeWindowId` -- see
       * `cmuxWindowIdForIdentity`'s doc comment for why this has to be on
       * the wire at all (the extension can't establish a pairing without
       * first learning the uuid to pair). null under the same conditions
       * as `homeChromeWindowId`. */
      cmuxWindowId: string | null;
    }
  | { type: "event"; seq: number; name: "focus_window" };

export interface ActuatorServerOptions {
  port: number;
  secret: string;
  registry: Registry;
  config: MetamuxConfig;
  cursor: CursorState;
  stats: ServerStats;
  groupProjection: GroupProjection;
  lazyGroups: LazyGroupTracker;
  /** Populates the `ports` field on /state and sync-frame workspace
   * objects, keyed by each ref's cmux sourceId. Omit when the ports
   * watcher is disabled (socket features off). */
  portsTracker?: PortsTracker;
  /** F9 reverse sync: called when an authed client sends
   * `{"type":"userActivatedGroup","id":"..."}` (an alias id in groupBy:
   * "title", a real workspace id in groupBy: "workspace"). The guard
   * (reverseSync config, socket features, id !== activeId) and the actual
   * `cmux rpc workspace.select` call live in main.ts -- this is just the
   * wire. */
  onUserActivatedGroup?: (id: string) => void;
  /** Detach-on-close: called when an authed client sends
   * `{"type":"userClosedGroup","id":"..."}` (the user closed a managed
   * Chrome group by hand). Clearing attachedAt (registry + lazyGroups) and
   * persisting live in main.ts -- this is just the wire. */
  onUserClosedGroup?: (id: string) => void;
  /** Placement ownership (docs/protocol.md, "Placement ownership"): called
   * when an authed client sends `{"type":"groupPlacement","id":"...",
   * "chromeWindowId":"..."|null}` -- the user moved (or the group returned
   * home, chromeWindowId: null) an identity's group to a Chrome window
   * other than its home. Resolving the wire id to a real ref and calling
   * Registry.setPlacementOverride lives in main.ts -- this is just the
   * wire. */
  onGroupPlacement?: (id: string, chromeWindowId: string | null) => void;
  /** Chrome window pairing (docs/protocol.md, "Chrome window pairing"):
   * called when an authed client sends `{"type":"windowPairing",
   * "cmuxWindowId":"...","chromeWindowId":"..."}` -- the extension
   * resolved (or created) the paired Chrome window for a cmux window via
   * its per-window marker tab. Not itself part of the written contract
   * (docs/protocol.md only specifies the persisted map and how it's
   * resolved "by marker tab") -- this is the reporting frame the marker-
   * tab flow needs to actually populate that map; named to mirror
   * `groupPlacement`'s shape. Registry.setWindowPairing + persisting live
   * in main.ts. */
  onWindowPairing?: (cmuxWindowId: string, chromeWindowId: string) => void;
  /** Chrome's own reported window geometry, the only bridge between its
   * integer windowId and a CGWindowID (docs/window-pairing-plan.md). */
  onWindowBounds?: (windows: ChromeWindowBounds[]) => void;
  /** Registry compaction (POST /prune, `metamux prune`): called after
   * `registry.pruneArchived(null)` actually removed something, so main.ts
   * can persist registry.json -- ActuatorServer owns no file I/O itself. */
  onPrune?: () => void | Promise<void>;
  log?: (line: string) => void;
}

export class ActuatorServer {
  private server: Server<WsData> | null = null;
  private clients = new Set<ServerWebSocket<WsData>>();
  private seq = 0;
  private log: (line: string) => void;
  private registry: Registry;
  private config: MetamuxConfig;
  private cursor: CursorState;
  private stats: ServerStats;
  private groupProjection: GroupProjection;
  private lazyGroups: LazyGroupTracker;
  private portsTracker?: PortsTracker;
  private onUserActivatedGroup?: (id: string) => void;
  private onUserClosedGroup?: (id: string) => void;
  private onGroupPlacement?: (id: string, chromeWindowId: string | null) => void;
  private onWindowPairing?: (cmuxWindowId: string, chromeWindowId: string) => void;
  private onWindowBounds?: (windows: ChromeWindowBounds[]) => void;
  private onPrune?: () => void | Promise<void>;
  private port: number;
  private secret: string;
  /** Workspace-scoped browser automation (docs/protocol.md): request/
   * response correlation for automationRequest/automationResponse frames
   * over the same WS the extension already uses. */
  private pendingAutomation = new PendingRequestTable();
  /** The most recently connected extension client's socket -- automation
   * requests target this one specifically (a raw broadcast would send the
   * same request to every connected client, including a non-extension
   * `fake-extension.ts`-style test client that would never answer it).
   * "Most recent" mirrors every other client-identity concern here: only
   * one real extension is ever expected, but a reconnect (service worker
   * restart) leaves the old socket's close event to clear this, and until
   * then the newer one is authoritative. */
  private extensionSocket: ServerWebSocket<WsData> | null = null;

  constructor(options: ActuatorServerOptions) {
    this.port = options.port;
    this.secret = options.secret;
    this.registry = options.registry;
    this.config = options.config;
    this.cursor = options.cursor;
    this.stats = options.stats;
    this.groupProjection = options.groupProjection;
    this.lazyGroups = options.lazyGroups;
    this.portsTracker = options.portsTracker;
    this.onUserActivatedGroup = options.onUserActivatedGroup;
    this.onUserClosedGroup = options.onUserClosedGroup;
    this.onGroupPlacement = options.onGroupPlacement;
    this.onWindowPairing = options.onWindowPairing;
    this.onWindowBounds = options.onWindowBounds;
    this.onPrune = options.onPrune;
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  start(): void {
    this.server = Bun.serve<WsData>({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: (req, server) => this.handleFetch(req, server),
      // Defense-in-depth: Bun already catches a fetch handler's own
      // throw/rejection and turns it into a generic 500 without this, but
      // an explicit handler logs it through our own log() and confirms
      // that safety net is actually wired, rather than relying on Bun's
      // undocumented default staying that way.
      error: (err) => {
        this.log(`[FATAL, CAUGHT] fetch handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        return new Response(JSON.stringify({ ok: false, error: "internal error" }), { status: 500 });
      },
      websocket: {
        open: () => {
          // wait for hello before doing anything
        },
        // Unlike fetch:, an uncaught throw here is NOT safely caught by
        // Bun -- it kills the entire process instantly (verified directly:
        // a fetch handler throw produces a 500 and the process survives;
        // a websocket.message handler throw does not, with no stack trace
        // surviving into daemon.log -- see docs/protocol.md, "Process-
        // level crash safety net"). handleWsMessage's own try/catch is the
        // primary guard; process.on("uncaughtException") in main.ts is the
        // last-resort net underneath it.
        message: (ws, message) => {
          try {
            this.handleWsMessage(ws, message);
          } catch (err) {
            this.log(`[FATAL, CAUGHT] websocket.message handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          }
        },
        close: (ws) => {
          this.clients.delete(ws);
          if (this.extensionSocket === ws) this.extensionSocket = null;
        },
      },
    });
    this.log(`metamux daemon on 127.0.0.1:${this.port}`);
  }

  stop(): void {
    this.server?.stop(true);
  }

  private checkToken(token: string | null): boolean {
    return token !== null && token === this.secret;
  }

  private currentSnapshot(): GroupProjectionSnapshot {
    return { workspaces: [...this.registry.workspaces.values()], activeId: this.registry.activeId };
  }

  /** Ports for a projected identity: that workspace's ports directly in
   * groupBy: "workspace"; the union (deduped, sorted) of every live
   * member's ports in groupBy: "title", since one alias can represent
   * several real workspaces. */
  private portsForIdentity(identity: ActuatorWorkspace, snapshot: GroupProjectionSnapshot): number[] | undefined {
    if (!this.portsTracker) return undefined;
    if (this.config.groupBy === "workspace") {
      const ref = snapshot.workspaces.find((w) => w.id === identity.id);
      return ref ? this.portsTracker.portsFor(ref.sourceId) : [];
    }
    const ports = new Set<number>();
    for (const member of snapshot.workspaces) {
      if (member.title !== identity.title || member.archived) continue;
      for (const p of this.portsTracker.portsFor(member.sourceId)) ports.add(p);
    }
    return [...ports].sort((a, b) => a - b);
  }

  /** The paired Chrome window for a projected identity's HOME cmux window
   * (docs/protocol.md, "Chrome window pairing") -- same shape as
   * portsForIdentity: that member's own cmuxWindowId in groupBy:
   * "workspace"; in groupBy: "title", the first LIVE member carrying one
   * (partition mode guarantees at most one live tmux-sourced member per
   * title in steady state, so this is unambiguous there; legacy windows/
   * global modes never stamp cmuxWindowId at all, so this resolves to null
   * for them, same as an unpaired window). Not baked into ActuatorWorkspace
   * itself -- spread onto the wire object at serialization time, exactly
   * like `ports`. */
  private homeChromeWindowIdForIdentity(identity: ActuatorWorkspace, snapshot: GroupProjectionSnapshot): string | null {
    if (this.config.groupBy === "workspace") {
      const ref = snapshot.workspaces.find((w) => w.id === identity.id);
      return ref ? this.registry.homeChromeWindowId(ref.cmuxWindowId) : null;
    }
    const member = snapshot.workspaces.find((w) => w.title === identity.title && !w.archived && w.cmuxWindowId !== null);
    return member ? this.registry.homeChromeWindowId(member.cmuxWindowId) : null;
  }

  /** Placement ownership (docs/protocol.md, "Placement ownership") for a
   * projected identity -- same representative-member shape as
   * homeChromeWindowIdForIdentity. */
  private placementOverrideForIdentity(identity: ActuatorWorkspace, snapshot: GroupProjectionSnapshot): string | null {
    if (this.config.groupBy === "workspace") {
      const ref = snapshot.workspaces.find((w) => w.id === identity.id);
      return ref ? ref.placementOverride : null;
    }
    const member = snapshot.workspaces.find((w) => w.title === identity.title && !w.archived && w.placementOverride !== null);
    return member ? member.placementOverride : null;
  }

  /** The raw cmux window id backing a projected identity's home, same
   * representative-member shape as homeChromeWindowIdForIdentity --
   * spread onto the wire alongside it. Without this, the extension has no
   * way to LEARN a cmux window's uuid at all: `homeChromeWindowId` alone
   * is null until a pairing already exists, and the pairing can only ever
   * be established by the extension creating a per-window marker tab at
   * `panel.html?win=<cmuxWindowId>` (docs/protocol.md, "Chrome window
   * pairing") -- which requires knowing the uuid first. This was a gap in
   * the contract as originally written; see protocol.md's "Implementation
   * notes" for the correction. */
  private cmuxWindowIdForIdentity(identity: ActuatorWorkspace, snapshot: GroupProjectionSnapshot): string | null {
    if (this.config.groupBy === "workspace") {
      const ref = snapshot.workspaces.find((w) => w.id === identity.id);
      return ref ? ref.cmuxWindowId : null;
    }
    const member = snapshot.workspaces.find((w) => w.title === identity.title && !w.archived && w.cmuxWindowId !== null);
    return member ? member.cmuxWindowId : null;
  }

  private handleFetch(req: Request, server: Server<WsData>): Response | Promise<Response> | undefined {
    const url = new URL(req.url);

    if (url.pathname === "/actuator") {
      const upgraded = server.upgrade(req, { data: { authed: false, client: null } });
      if (upgraded) return undefined;
      return new Response("Upgrade failed", { status: 400 });
    }

    if (url.pathname === "/open" && req.method === "POST") {
      return this.handleOpen(req);
    }

    if (url.pathname === "/focus" && req.method === "POST") {
      return this.handleFocus(req);
    }

    if (url.pathname === "/prune" && req.method === "POST") {
      return this.handlePrune(req);
    }

    if (url.pathname === "/automation" && req.method === "POST") {
      return this.handleAutomation(req);
    }

    if (url.pathname === "/status" && req.method === "GET") {
      if (!this.checkToken(url.searchParams.get("token"))) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      return Response.json(this.getStatus());
    }

    if (url.pathname === "/state" && req.method === "GET") {
      if (!this.checkToken(url.searchParams.get("token"))) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      return Response.json(this.getState());
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleOpen(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid body" }), { status: 400 });
    }
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const token = typeof obj.token === "string" ? obj.token : null;
    if (!this.checkToken(token)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
    }
    const urlStr = typeof obj.url === "string" ? obj.url : null;
    if (!urlStr) {
      return new Response(JSON.stringify({ ok: false, error: "missing url" }), { status: 400 });
    }
    const cmuxWorkspaceId = typeof obj.cmuxWorkspaceId === "string" ? obj.cmuxWorkspaceId : null;

    let target: WorkspaceRef | null = null;
    if (cmuxWorkspaceId) {
      for (const ref of this.registry.workspaces.values()) {
        if (ref.sourceId === cmuxWorkspaceId) {
          target = ref;
          break;
        }
      }
    } else if (this.registry.activeId) {
      target = this.registry.workspaces.get(this.registry.activeId) ?? null;
    }

    if (!target) {
      return new Response(JSON.stringify({ ok: false, error: "no target workspace" }), { status: 404 });
    }

    const identity = this.pushOpenUrl(target, urlStr);
    return Response.json({ ok: true, workspace: identity.id });
  }

  private async handleFocus(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid body" }), { status: 400 });
    }
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const token = typeof obj.token === "string" ? obj.token : null;
    if (!this.checkToken(token)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
    }

    this.seq++;
    this.broadcastRaw({ type: "event", seq: this.seq, name: "focus_window" });
    this.log(`[focus_window]`);
    return Response.json({ ok: true });
  }

  /** Registry compaction, hot: deletes ALL archived refs (no age cutoff --
   * that's the auto-compact startup path in main.ts, which calls
   * `registry.pruneArchived` directly). Persists via onPrune and pushes a
   * fresh sync to every client so the extension's own byId prunes in
   * lockstep (sync-authoritative byId, reducer.js's reduceSync) instead of
   * carrying stale entries for refs the registry no longer has at all. */
  private async handlePrune(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid body" }), { status: 400 });
    }
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const token = typeof obj.token === "string" ? obj.token : null;
    if (!this.checkToken(token)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
    }

    const removed = this.registry.pruneArchived(null);
    if (removed.length > 0) {
      await this.onPrune?.();
      this.pushSyncToAll();
    }
    this.log(
      `[prune] removed ${removed.length} archived workspace(s)${removed.length > 0 ? ": " + removed.map((r) => r.title).join(", ") : ""}`,
    );
    return Response.json({ ok: true, removed: removed.map((r) => ({ id: r.id, title: r.title })) });
  }

  /** Workspace-scoped browser automation (docs/protocol.md, "Workspace-
   * scoped browser automation"): relays one op to the extension over the
   * WS and awaits its response. Resolves the target workspace the same
   * way POST /open does (explicit `workspaceId` -- metamux's own mw_ id,
   * matching what the MCP layer already resolves via GET /state -- else
   * the active workspace), then resolves that ref's WIRE identity (the
   * extension's byId is keyed by identity, not real ref id) before
   * sending. `agentBrowser` config gates which op kinds are allowed at
   * all (automation-policy.ts); "no extension connected" is a distinct,
   * immediate error, never a 15s timeout wait for a peer that isn't there. */
  private async handleAutomation(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid body" }), { status: 400 });
    }
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const token = typeof obj.token === "string" ? obj.token : null;
    if (!this.checkToken(token)) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
    }

    const op = obj.op && typeof obj.op === "object" ? (obj.op as Record<string, unknown>) : null;
    const opKind = op && typeof op.kind === "string" ? op.kind : null;
    if (!op || !opKind) {
      return new Response(JSON.stringify({ ok: false, error: "missing op.kind" }), { status: 400 });
    }
    if (!toolAllowed(opKind, this.config.agentBrowser)) {
      return new Response(
        JSON.stringify({ ok: false, error: `"${opKind}" is not allowed under agentBrowser: "${this.config.agentBrowser}"` }),
        { status: 403 },
      );
    }

    const workspaceId = typeof obj.workspaceId === "string" ? obj.workspaceId : null;
    const target = workspaceId ? (this.registry.workspaces.get(workspaceId) ?? null) : this.activeRef();
    if (!target) {
      return new Response(JSON.stringify({ ok: false, error: "no target workspace" }), { status: 404 });
    }

    if (opKind === "navigate") {
      const urlStr = typeof op.url === "string" ? op.url : null;
      if (!urlStr) return new Response(JSON.stringify({ ok: false, error: "missing op.url" }), { status: 400 });
      const decision = await this.decideNavigateForTarget(urlStr, target);
      if (decision.action === "block") {
        return new Response(JSON.stringify({ ok: false, error: `navigate blocked: ${decision.reason}` }), { status: 403 });
      }
    }

    if (!this.extensionSocket) {
      return new Response(JSON.stringify({ ok: false, error: "no extension connected" }), { status: 503 });
    }

    const snapshot = this.currentSnapshot();
    const identity = this.groupProjection.identityFor(target, snapshot);
    const id = crypto.randomUUID();
    const pending = this.pendingAutomation.register(id, AUTOMATION_TIMEOUT_MS);
    this.extensionSocket.send(JSON.stringify({ type: "automationRequest", id, identityId: identity.id, op }));
    this.log(`[automation] -> ${identity.title} (${identity.id}) op=${opKind}`);

    try {
      const result = await pending;
      return Response.json({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[automation] FAILED op=${opKind}: ${message}`);
      return new Response(JSON.stringify({ ok: false, error: message }), { status: 502 });
    }
  }

  private activeRef(): WorkspaceRef | null {
    return this.registry.activeId ? (this.registry.workspaces.get(this.registry.activeId) ?? null) : null;
  }

  /** SSRF gate for a navigate op (navigate-gate.ts's decideNavigate is
   * pure -- this is its I/O wrapper): resolves the URL's hostname via a
   * real DNS lookup and looks up the target workspace's OWN observed
   * ports (PortsTracker) for the loopback allowlist, so a dev server
   * running in one workspace doesn't open loopback access to every other
   * workspace's automation calls. Resolution failure passes an empty IP
   * list through -- decideNavigate itself fails closed on that. */
  private async decideNavigateForTarget(urlStr: string, target: WorkspaceRef) {
    let hostname: string | null = null;
    try {
      hostname = new URL(urlStr).hostname;
    } catch {
      // decideNavigate rejects the unparseable URL itself, below
    }
    let resolvedIps: string[] = [];
    if (hostname) {
      try {
        const results = await lookup(hostname, { all: true });
        resolvedIps = results.map((r) => r.address);
      } catch {
        resolvedIps = [];
      }
    }
    const observedPorts = this.portsTracker ? this.portsTracker.portsFor(target.sourceId) : [];
    return decideNavigate(urlStr, observedPorts, resolvedIps);
  }

  /** Push an open_url event for a resolved workspace ref -- projected to
   * its alias in groupBy: "title". Shared by POST /open and the ports
   * watcher (main.ts). Returns the identity it was pushed to. Also marks
   * the identity attached -- the ONLY attachment path in createGroups:
   * "on-open"; also true in "on-activate", where activation attaches too.
   * markAttached runs BEFORE identityFor deliberately: in colorMode:
   * "palette" it's also where the palette color gets claimed (registry.ts),
   * and the very first open_url for a freshly-created group must already
   * carry that allocated color, not a stale pre-claim one. */
  pushOpenUrl(target: WorkspaceRef, urlStr: string): ActuatorWorkspace {
    this.registry.markAttached(target.id); // persisted -- survives a restart
    const snapshot = this.currentSnapshot();
    const identity = this.groupProjection.identityFor(target, snapshot);
    this.lazyGroups.markAttached(identity.id); // in-memory wire-identity cache for this session
    const homeChromeWindowId = this.homeChromeWindowIdForIdentity(identity, snapshot);
    const cmuxWindowId = this.cmuxWindowIdForIdentity(identity, snapshot);
    this.seq++;
    this.broadcastRaw({ type: "event", seq: this.seq, name: "open_url", workspace: identity, url: urlStr, homeChromeWindowId, cmuxWindowId });
    this.log(`[open_url] ${identity.title} (${identity.id}) -> ${urlStr}${homeChromeWindowId ? ` [win ${homeChromeWindowId}]` : ""}`);
    return identity;
  }

  /** Follow-the-tab: tell the extension to move a title's group into the Chrome
   * window now paired with the workspace's new cmux window. */
  pushMoveGroupToWindow(aliasId: string, title: string, chromeWindowId: number): void {
    this.seq++;
    this.broadcastRaw({
      type: "event",
      seq: this.seq,
      name: "move_group_to_window",
      id: aliasId,
      title,
      chromeWindowId,
    });
    this.log(`[follow-tab] ${title} (${aliasId}) -> chrome window ${chromeWindowId}`);
  }

  private handleWsMessage(ws: ServerWebSocket<WsData>, message: string | Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;

    if (obj.type === "hello") {
      const token = typeof obj.token === "string" ? obj.token : null;
      if (!this.checkToken(token)) {
        ws.close(4001, "bad token");
        return;
      }
      const client = typeof obj.client === "string" ? obj.client : "unknown";
      ws.data.authed = true;
      ws.data.client = client;
      this.clients.add(ws);
      if (client === "extension") this.extensionSocket = ws;
      ws.send(JSON.stringify(this.buildSync()));
      const label = client === "extension" ? "extension connected ✓" : `${client} client connected ✓`;
      this.log(label);
      return;
    }

    if (!ws.data.authed) return; // ignore anything before a valid hello

    if (obj.type === "state") {
      // Sent by the extension's tab-group janitor, one entry per group it
      // classified FOREIGN (title not in its pruned byId). A "foreign" title
      // that actually matches a live identity is an ORPHANED group -- its
      // attachment was lost (e.g. across the on-open rework), the sync then
      // omitted the identity, and the extension pruned it, making a real
      // group invisible to activation. Adopt it: re-attach the identity so
      // the next sync re-includes it and the extension re-binds the group.
      const groups = Array.isArray(obj.groups) ? (obj.groups as Array<Record<string, unknown>>) : [];
      let adopted = 0;
      const snapshot = this.currentSnapshot();
      const projected = this.groupProjection.projectState(snapshot);
      for (const g of groups) {
        const title = typeof g.title === "string" ? g.title : null;
        if (!title) continue;
        const identity = projected.workspaces.find((w) => w.title === title && !w.archived);
        if (!identity || this.lazyGroups.isAttached(identity.id)) {
          this.log(`janitor: leaving unknown group '${title}' (${g.tabCount} tabs)`);
          continue;
        }
        const member = snapshot.workspaces.find((w) => w.title === title && !w.archived);
        if (member) {
          this.registry.markAttached(member.id);
          // The report carries where the orphan actually lives; record it as
          // the placement so activation finds the group IN PLACE instead of
          // re-homing it to the legacy window. Never clobber an existing override.
          const windowId = typeof g.windowId === "string" ? g.windowId : null;
          if (windowId && member.placementOverride === null) member.placementOverride = windowId;
        }
        this.lazyGroups.markAttached(identity.id);
        this.log(`adopted orphaned group '${title}' as attached ✓`);
        adopted++;
      }
      if (adopted > 0) {
        void this.onPrune?.(); // persist the re-attachments
        this.pushSyncToAll();
      }
      return;
    }

    if (obj.type === "userActivatedGroup") {
      const id = typeof obj.id === "string" ? obj.id : null;
      if (id) this.onUserActivatedGroup?.(id);
      return;
    }

    if (obj.type === "userClosedGroup") {
      const id = typeof obj.id === "string" ? obj.id : null;
      if (id) this.onUserClosedGroup?.(id);
      return;
    }

    if (obj.type === "groupPlacement") {
      const id = typeof obj.id === "string" ? obj.id : null;
      const chromeWindowId = typeof obj.chromeWindowId === "string" ? obj.chromeWindowId : null;
      if (id) this.onGroupPlacement?.(id, chromeWindowId);
      return;
    }

    if (obj.type === "windowPairing") {
      const cmuxWindowId = typeof obj.cmuxWindowId === "string" ? obj.cmuxWindowId : null;
      const chromeWindowId = typeof obj.chromeWindowId === "string" ? obj.chromeWindowId : null;
      if (cmuxWindowId && chromeWindowId) this.onWindowPairing?.(cmuxWindowId, chromeWindowId);
      return;
    }

    if (obj.type === "windowBounds") {
      const raw = Array.isArray(obj.windows) ? obj.windows : [];
      const windows: ChromeWindowBounds[] = [];
      for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        if (
          typeof e.id === "number" &&
          typeof e.left === "number" &&
          typeof e.top === "number" &&
          typeof e.width === "number" &&
          typeof e.height === "number"
        ) {
          windows.push({ id: e.id, left: e.left, top: e.top, width: e.width, height: e.height });
        }
      }
      this.onWindowBounds?.(windows);
      return;
    }

    if (obj.type === "automationResponse") {
      const id = typeof obj.id === "string" ? obj.id : null;
      if (!id) return;
      if (obj.ok === true) {
        this.pendingAutomation.resolveRequest(id, obj.result);
      } else {
        const message = typeof obj.error === "string" ? obj.error : "automation request failed";
        this.pendingAutomation.rejectRequest(id, new Error(message));
      }
    }
  }

  /** Config hot-reload: push a fresh sync frame to every connected client
   * so the extension re-reads config.collapseOthers/closeBehavior (and the
   * current, possibly re-grouped/re-filtered state) without reconnecting. */
  pushSyncToAll(): void {
    const payload = JSON.stringify(this.buildSync());
    for (const ws of this.clients) {
      if (ws.data.authed) ws.send(payload);
    }
  }

  private buildSync() {
    const snapshot = this.currentSnapshot();
    const projected = this.groupProjection.projectState(snapshot);
    const workspaces =
      this.config.createGroups !== "eager" ? this.lazyGroups.filterForSync(projected.workspaces) : projected.workspaces;

    return {
      type: "sync",
      seq: this.seq,
      config: {
        collapseOthers: this.config.collapseOthers,
        closeBehavior: this.config.closeBehavior,
        janitor: this.config.janitor,
        janitorCrossWindow: this.config.janitorCrossWindow,
      },
      state: {
        activeId: projected.activeId,
        workspaces: workspaces.map((w) => ({
          ...w,
          ...(this.portsTracker ? { ports: this.portsForIdentity(w, snapshot) } : {}),
          homeChromeWindowId: this.homeChromeWindowIdForIdentity(w, snapshot),
          cmuxWindowId: this.cmuxWindowIdForIdentity(w, snapshot),
          placementOverride: this.placementOverrideForIdentity(w, snapshot),
        })),
      },
    };
  }

  private broadcastRaw(event: PushedEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.data.authed) ws.send(payload);
    }
  }

  /** Broadcast raw per-workspace actuator events (from registry.applyEvent):
   * projects each through groupProjection (alias-collapsed in groupBy:
   * "title"), marks activated identities attached (createGroups:
   * "on-activate" only -- "on-open" attaches solely via pushOpenUrl),
   * applies the lazy inclusion filter to `workspace.upserted` unless
   * createGroups is "eager", then broadcasts what remains -- assigning
   * monotonic seq and logging one line per event actually sent. */
  broadcast(rawEvents: ActuatorEvent[]): void {
    const snapshot = this.currentSnapshot();
    const projected = rawEvents.flatMap((raw) => this.groupProjection.project(raw, snapshot));

    if (this.config.createGroups !== "on-open") {
      for (const event of projected) {
        if (event.name === "workspace.activated") this.lazyGroups.markAttached(event.workspace.id);
      }
    }

    const final = this.config.createGroups !== "eager" ? this.lazyGroups.filterEvents(projected) : projected;

    for (const event of final) {
      this.seq++;
      this.broadcastRaw({ type: "event", seq: this.seq, name: event.name, workspace: event.workspace });
      this.log(`[${event.name}] ${event.workspace.title} (${event.workspace.id}) color=${event.workspace.color}`);
    }
  }

  getStatus() {
    return {
      ok: true,
      clients: this.clients.size,
      lastSeq: this.seq,
      activeId: this.registry.activeId,
      workspaces: this.registry.workspaces.size,
      cursor: this.cursor,
      skippedLines: this.stats.skippedLines,
    };
  }

  /** Raw per-workspace registry state (unchanged, full fidelity) alongside
   * the projected wire view (alias-collapsed and lazy-filtered per the
   * current config) -- so `metamux state` / doctor-style tooling can see
   * both what the registry actually holds and what the extension sees. */
  getState() {
    const snapshot = this.currentSnapshot();
    const projected = this.groupProjection.projectState(snapshot);
    const projectedWorkspaces =
      this.config.createGroups !== "eager" ? this.lazyGroups.filterForSync(projected.workspaces) : projected.workspaces;

    return {
      activeId: this.registry.activeId,
      workspaces: [...this.registry.workspaces.values()].map((ref) => ({
        ...ref,
        ...(this.portsTracker ? { ports: this.portsForIdentity(this.groupProjection.identityFor(ref, snapshot), snapshot) } : {}),
      })),
      projected: {
        groupBy: this.config.groupBy,
        createGroups: this.config.createGroups,
        activeId: projected.activeId,
        workspaces: projectedWorkspaces.map((w) => ({
          ...w,
          ...(this.portsTracker ? { ports: this.portsForIdentity(w, snapshot) } : {}),
          homeChromeWindowId: this.homeChromeWindowIdForIdentity(w, snapshot),
          cmuxWindowId: this.cmuxWindowIdForIdentity(w, snapshot),
          placementOverride: this.placementOverrideForIdentity(w, snapshot),
        })),
      },
    };
  }
}
