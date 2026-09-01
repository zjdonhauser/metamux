// `metamux mcp`: a minimal stdio JSON-RPC 2.0 MCP server bridging to the
// daemon's HTTP API. The router (createRouter) is pure -- it takes tool
// handlers as data, so it's testable without a live daemon. The HTTP
// bridge (createHttpToolHandlers) and the stdio transport (runStdioServer)
// are the I/O boundary.

import { notInTmuxMessage, probeTmuxIdentity, type CallerIdentity } from "./model/caller-identity.ts";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolContent {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolContent>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const METAMUX_MCP_TOOLS: McpTool[] = [
  {
    name: "metamux_current",
    description: "Get the currently active cmux workspace: id, title, cwd, and any detected listening ports.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "metamux_workspaces",
    description: "List all non-archived cmux workspaces metamux is tracking.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "metamux_open",
    description:
      "Show a URL to the human. The URL opens as a new tab in a workspace's Chrome tab group. " +
      "The default target is the calling shell's own workspace, so a link lands where the agent " +
      "works, not in the tab the human looks at. " +
      "Use this tool only for a URL the human must see. Each call adds one tab, and the tab stays " +
      "until the human closes it. Do not open an enumerated list, such as every open PR or every " +
      "ticket: this buries the workspace in tabs nobody asked for. " +
      "Do not use this tool to read or collect content. To read a page, use the API or the CLI for " +
      "that system, such as `gh` for GitHub. To inspect a tab that is already open, use " +
      "metamux_tab_context or metamux_browser_snapshot. " +
      "Deduping: a second call with the SAME url activates the existing tab instead of opening " +
      "another. This match is exact -- a different query string or fragment (a different PR, a " +
      "different tab within the same page) counts as a different URL and opens a new tab. If you " +
      "want to reuse a tab whose URL is close but not identical, call metamux_tab_context first " +
      "and decide for yourself: that judgment belongs to you, since only you know whether it is " +
      "really the same thing.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        workspaceId: { type: "string", description: "metamux workspace id (mw_...); defaults to the calling shell's workspace" },
        active: {
          type: "boolean",
          description: "Target the visually active workspace instead of the calling shell's. Ignored when workspaceId is set.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "metamux_tab_context",
    description:
      "List the open tabs in the calling workspace's own Chrome tab group: id, url, title, and which one is active. " +
      "Read-only, no new browser permissions used. Scoped strictly to the calling workspace -- never any other group.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "metamux workspace id (mw_...); defaults to the calling shell's workspace" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "metamux_browser_snapshot",
    description:
      "Get a compact, agent-readable snapshot of the calling workspace's active browser tab: interactive elements " +
      "(links, buttons, inputs, ...) each with a stable `ref`, tag, role, and visible text. Pass a ref from this " +
      "snapshot to metamux_browser_click. Requires agentBrowser: read or full.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "metamux workspace id (mw_...); defaults to the calling shell's workspace" },
        tabId: { type: "number", description: "specific tab id within the workspace's group; defaults to its active tab" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "metamux_browser_screenshot",
    description:
      "Capture a PNG screenshot of the calling workspace's active browser tab, returned as an image content block. " +
      "Requires agentBrowser: read or full.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "metamux workspace id (mw_...); defaults to the calling shell's workspace" },
        tabId: { type: "number", description: "specific tab id within the workspace's group; defaults to its active tab" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "metamux_browser_navigate",
    description:
      "Navigate the calling workspace's active browser tab to a URL. http/https only -- internal/private/loopback " +
      "hosts are blocked (a loopback URL is allowed only on a port metamux's own port watcher has actually observed " +
      "in this workspace). Requires agentBrowser: full.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http/https URL to navigate to" },
        workspaceId: { type: "string", description: "metamux workspace id (mw_...); defaults to the calling shell's workspace" },
        tabId: { type: "number", description: "specific tab id within the workspace's group; defaults to its active tab" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "metamux_browser_click",
    description:
      "Click an element in the calling workspace's active browser tab, by the `ref` a prior metamux_browser_snapshot " +
      "returned for it. Requires agentBrowser: full.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "an element ref from a recent metamux_browser_snapshot call" },
        workspaceId: { type: "string", description: "metamux workspace id (mw_...); defaults to the calling shell's workspace" },
        tabId: { type: "number", description: "specific tab id within the workspace's group; defaults to its active tab" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "metamux_browser_type",
    description:
      "Type text into whatever element currently has focus in the calling workspace's active browser tab -- click " +
      "the target field first with metamux_browser_click. Requires agentBrowser: full.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "text to type" },
        workspaceId: { type: "string", description: "metamux workspace id (mw_...); defaults to the calling shell's workspace" },
        tabId: { type: "number", description: "specific tab id within the workspace's group; defaults to its active tab" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const PROTOCOL_VERSION_FALLBACK = "2024-11-05";

function isNotification(request: JsonRpcRequest): boolean {
  return !("id" in request) || request.id === undefined;
}

function errorContent(err: unknown): McpToolContent {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text }], isError: true };
}

/** Pure request router. Takes tool handlers as data so it's testable
 * without a live daemon. Returns null for a notification (no response
 * expected on JSON-RPC 2.0). */
export function createRouter(handlers: Record<string, ToolHandler>) {
  return async function handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (isNotification(request)) return null;
    const id = request.id ?? null;

    if (request.method === "initialize") {
      const params = (request.params && typeof request.params === "object") ? (request.params as Record<string, unknown>) : {};
      const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION_FALLBACK;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          serverInfo: { name: "metamux", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      };
    }

    if (request.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: METAMUX_MCP_TOOLS } };
    }

    if (request.method === "tools/call") {
      const params = (request.params && typeof request.params === "object") ? (request.params as Record<string, unknown>) : {};
      const name = typeof params.name === "string" ? params.name : "";
      const handler = handlers[name];
      if (!handler) {
        return { jsonrpc: "2.0", id, result: errorContent(new Error(`Unknown tool: ${name}`)) };
      }
      const args = (params.arguments && typeof params.arguments === "object") ? (params.arguments as Record<string, unknown>) : {};
      try {
        const result = await handler(args);
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: errorContent(err) };
      }
    }

    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } };
  };
}

// --- HTTP bridge (I/O boundary) ---

export interface HttpBridgeOptions {
  port: number;
  token: string;
  fetchImpl?: typeof fetch;
}

async function bridgeGet(path: string, options: HttpBridgeOptions): Promise<Record<string, unknown>> {
  const f = options.fetchImpl ?? fetch;
  const res = await f(`http://127.0.0.1:${options.port}${path}?token=${encodeURIComponent(options.token)}`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`daemon returned ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

interface StateWorkspace {
  id: string;
  title: string;
  cwd: string | null;
  archived: boolean;
  ports?: number[];
}

async function fetchState(options: HttpBridgeOptions): Promise<{ activeId: string | null; workspaces: StateWorkspace[] }> {
  const state = await bridgeGet("/state", options);
  return {
    activeId: (state.activeId as string | null) ?? null,
    workspaces: (state.workspaces as StateWorkspace[]) ?? [],
  };
}

/** Workspace resolution for automation tools: explicit `args.workspaceId`
 * wins; else, when this MCP server process inherited a shell's
 * $CMUX_WORKSPACE_ID (a cmux sourceId, NOT metamux's own mw_ id), resolve
 * it to the matching mw_ id via GET /state; else undefined, and POST
 * /automation falls back to the daemon's own activeId server-side. NOTE:
 * whether a spawned MCP server actually inherits CMUX_WORKSPACE_ID varies
 * by harness/launcher -- this chain is best-effort, not guaranteed (see
 * the build report). */
async function resolveAutomationWorkspaceId(args: Record<string, unknown>, options: HttpBridgeOptions): Promise<string | undefined> {
  const explicit = typeof args.workspaceId === "string" ? args.workspaceId : null;
  if (explicit) return explicit;

  const envSourceId = process.env.CMUX_WORKSPACE_ID;
  if (!envSourceId) return undefined;

  const raw = await bridgeGet("/state", options);
  const rawWorkspaces = (raw.workspaces as Record<string, unknown>[]) ?? [];
  const match = rawWorkspaces.find((w) => w.sourceId === envSourceId);
  return typeof match?.id === "string" ? match.id : undefined;
}

/** POSTs one automation op and returns its result, or throws with the
 * daemon's own error message (unauthorized / disallowed by agentBrowser /
 * no extension connected / op-level failure -- all surfaced the same way,
 * createRouter's tools/call catch turns any thrown error into isError
 * content). */
async function postAutomation(
  options: HttpBridgeOptions,
  op: Record<string, unknown>,
  workspaceId: string | undefined,
): Promise<unknown> {
  const f = options.fetchImpl ?? fetch;
  const res = await f(`http://127.0.0.1:${options.port}/automation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: options.token, workspaceId, op }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok !== true) {
    throw new Error(typeof body.error === "string" ? body.error : `automation request failed: ${res.status}`);
  }
  return body.result;
}

/** The real tool handlers: bridge each MCP tool to the daemon's HTTP API. */
export function createHttpToolHandlers(options: HttpBridgeOptions): Record<string, ToolHandler> {
  return {
    metamux_current: async () => {
      const state = await fetchState(options);
      const active = state.activeId ? state.workspaces.find((w) => w.id === state.activeId) : null;
      if (!active) return { content: [{ type: "text", text: "no active workspace" }] };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id: active.id, title: active.title, cwd: active.cwd, ports: active.ports ?? [] }),
          },
        ],
      };
    },

    metamux_workspaces: async () => {
      const state = await fetchState(options);
      const nonArchived = state.workspaces
        .filter((w) => !w.archived)
        .map((w) => ({ id: w.id, title: w.title, cwd: w.cwd, ports: w.ports ?? [] }));
      return { content: [{ type: "text", text: JSON.stringify(nonArchived) }] };
    },

    metamux_open: async (args) => {
      const url = typeof args.url === "string" ? args.url : null;
      if (!url) throw new Error("url is required");

      let cmuxWorkspaceId: string | undefined;
      const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : null;
      if (workspaceId) {
        const state = await fetchState(options);
        const target = state.workspaces.find((w) => w.id === workspaceId);
        if (!target) throw new Error(`unknown workspaceId: ${workspaceId}`);
        // POST /open resolves by cmux sourceId, not metamux's own id -- look
        // it up via GET /state's raw registry shape (sourceId isn't in the
        // trimmed StateWorkspace type above, so re-fetch the full record).
        const raw = await bridgeGet("/state", options);
        const rawWorkspaces = (raw.workspaces as Record<string, unknown>[]) ?? [];
        const rawMatch = rawWorkspaces.find((w) => w.id === workspaceId);
        cmuxWorkspaceId = typeof rawMatch?.sourceId === "string" ? rawMatch.sourceId : undefined;
      }

      // Identity comes from the tmux session this process is in, asked for at
      // call time. The MCP server is long-lived (instances here have run for
      // days), so an env var captured when it spawned is the staler of the two.
      let identity: CallerIdentity = { kind: "not-in-tmux" };
      if (!workspaceId && args.active !== true) {
        identity = probeTmuxIdentity();
        if (identity.kind === "not-in-tmux") {
          // Fail loud rather than letting the daemon place the link in whichever
          // group is on screen, which is how links reached a stranger's group.
          throw new Error(notInTmuxMessage(url));
        }
      }

      const f = options.fetchImpl ?? fetch;
      const res = await f(`http://127.0.0.1:${options.port}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: options.token,
          url,
          cmuxWorkspaceId,
          active: args.active === true,
          tmuxSessionName: identity.kind === "tmux" ? identity.sessionName : undefined,
          metamuxId: identity.kind === "tmux" ? identity.metamuxId : undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`daemon returned ${res.status}: ${JSON.stringify(body)}`);
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    },

    metamux_tab_context: async (args) => {
      const workspaceId = await resolveAutomationWorkspaceId(args, options);
      const result = await postAutomation(options, { kind: "tabContext" }, workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },

    metamux_browser_snapshot: async (args) => {
      const workspaceId = await resolveAutomationWorkspaceId(args, options);
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      const result = await postAutomation(options, { kind: "snapshot", tabId }, workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },

    metamux_browser_screenshot: async (args) => {
      const workspaceId = await resolveAutomationWorkspaceId(args, options);
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      const result = (await postAutomation(options, { kind: "screenshot", tabId }, workspaceId)) as { imageBase64: string };
      return { content: [{ type: "image", data: result.imageBase64, mimeType: "image/png" }] };
    },

    metamux_browser_navigate: async (args) => {
      const url = typeof args.url === "string" ? args.url : null;
      if (!url) throw new Error("url is required");
      const workspaceId = await resolveAutomationWorkspaceId(args, options);
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      const result = await postAutomation(options, { kind: "navigate", url, tabId }, workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },

    metamux_browser_click: async (args) => {
      const ref = typeof args.ref === "string" ? args.ref : null;
      if (!ref) throw new Error("ref is required");
      const workspaceId = await resolveAutomationWorkspaceId(args, options);
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      const result = await postAutomation(options, { kind: "click", ref, tabId }, workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },

    metamux_browser_type: async (args) => {
      const text = typeof args.text === "string" ? args.text : null;
      if (text === null) throw new Error("text is required");
      const workspaceId = await resolveAutomationWorkspaceId(args, options);
      const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
      const result = await postAutomation(options, { kind: "type", text, tabId }, workspaceId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  };
}

// --- stdio transport (I/O boundary) ---

/** Reads newline-delimited JSON-RPC requests from stdin, writes
 * newline-delimited responses to stdout. Runs until stdin closes. */
export async function runStdioServer(handlers: Record<string, ToolHandler>): Promise<void> {
  const handle = createRouter(handlers);
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += Buffer.from(chunk).toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(trimmed);
      } catch {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n",
        );
        continue;
      }

      const response = await handle(request);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
}
