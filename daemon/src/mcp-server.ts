// `metamux mcp`: a minimal stdio JSON-RPC 2.0 MCP server bridging to the
// daemon's HTTP API. The router (createRouter) is pure -- it takes tool
// handlers as data, so it's testable without a live daemon. The HTTP
// bridge (createHttpToolHandlers) and the stdio transport (runStdioServer)
// are the I/O boundary.

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
  content: { type: "text"; text: string }[];
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
    description: "Open a URL in the Chrome tab group for a workspace. Defaults to the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        workspaceId: { type: "string", description: "metamux workspace id (mw_...); defaults to the active workspace" },
      },
      required: ["url"],
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

      const f = options.fetchImpl ?? fetch;
      const res = await f(`http://127.0.0.1:${options.port}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: options.token, url, cmuxWorkspaceId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`daemon returned ${res.status}: ${JSON.stringify(body)}`);
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
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
