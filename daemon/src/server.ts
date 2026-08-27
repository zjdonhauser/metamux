// Bun.serve on 127.0.0.1:<port>: WS /actuator + HTTP POST /open, GET /status,
// GET /state, POST /focus. One port, per docs/protocol.md "Wire protocol"
// and "Phase 2 additions".
//
// Wire-projection layer: raw per-workspace registry state/events are
// projected through GroupProjection (groupBy: title-aliasing) and
// LazyGroupTracker (createGroups: "on-open"/"on-activate" lazy inclusion) before anything reaches
// a client. The Registry itself never sees either concern.

import type { Server, ServerWebSocket } from "bun";
import type { MetamuxConfig } from "./config.ts";
import type { GroupProjection, GroupProjectionSnapshot } from "./group-projection.ts";
import type { LazyGroupTracker } from "./lazy-groups.ts";
import type { PortsTracker } from "./ports.ts";
import type { ActuatorEvent, ActuatorWorkspace, Registry, WorkspaceRef } from "./registry.ts";

interface WsData {
  authed: boolean;
  client: string | null;
}

interface CursorState {
  bootId: string;
  seq: number;
}

export interface ServerStats {
  skippedLines: number;
}

type PushedEvent =
  | { type: "event"; seq: number; name: ActuatorEvent["name"]; workspace: ActuatorWorkspace }
  | { type: "event"; seq: number; name: "open_url"; workspace: ActuatorWorkspace; url: string }
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
  private port: number;
  private secret: string;

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
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  start(): void {
    this.server = Bun.serve<WsData>({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: (req, server) => this.handleFetch(req, server),
      websocket: {
        open: () => {
          // wait for hello before doing anything
        },
        message: (ws, message) => this.handleWsMessage(ws, message),
        close: (ws) => {
          this.clients.delete(ws);
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

  /** Push an open_url event for a resolved workspace ref -- projected to
   * its alias in groupBy: "title". Shared by POST /open and the ports
   * watcher (main.ts). Returns the identity it was pushed to. Also marks
   * the identity attached -- the ONLY attachment path in createGroups:
   * "on-open"; also true in "on-activate", where activation attaches too. */
  pushOpenUrl(target: WorkspaceRef, urlStr: string): ActuatorWorkspace {
    const snapshot = this.currentSnapshot();
    const identity = this.groupProjection.identityFor(target, snapshot);
    this.registry.markAttached(target.id); // persisted -- survives a restart
    this.lazyGroups.markAttached(identity.id); // in-memory wire-identity cache for this session
    this.seq++;
    this.broadcastRaw({ type: "event", seq: this.seq, name: "open_url", workspace: identity, url: urlStr });
    this.log(`[open_url] ${identity.title} (${identity.id}) -> ${urlStr}`);
    return identity;
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
      ws.send(JSON.stringify(this.buildSync()));
      const label = client === "extension" ? "extension connected ✓" : `${client} client connected ✓`;
      this.log(label);
      return;
    }

    if (!ws.data.authed) return; // ignore anything before a valid hello

    if (obj.type === "state") {
      // Currently sent only by the extension's tab-group janitor, one entry
      // per unrecognized (FOREIGN) group it left untouched.
      const groups = Array.isArray(obj.groups) ? (obj.groups as Array<Record<string, unknown>>) : [];
      for (const g of groups) {
        this.log(`janitor: leaving unknown group '${g.title}' (${g.tabCount} tabs)`);
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
      },
      state: {
        activeId: projected.activeId,
        workspaces: workspaces.map((w) => ({
          ...w,
          ...(this.portsTracker ? { ports: this.portsForIdentity(w, snapshot) } : {}),
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
        })),
      },
    };
  }
}
