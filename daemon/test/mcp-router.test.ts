import { describe, expect, test } from "bun:test";
import { createRouter, METAMUX_MCP_TOOLS, type ToolHandler } from "../src/mcp-server.ts";

function makeHandlers(overrides: Partial<Record<string, ToolHandler>> = {}): Record<string, ToolHandler> {
  return {
    metamux_current: async () => ({ content: [{ type: "text", text: JSON.stringify({ id: "mw_1" }) }] }),
    metamux_workspaces: async () => ({ content: [{ type: "text", text: "[]" }] }),
    metamux_open: async () => ({ content: [{ type: "text", text: "ok" }] }),
    ...overrides,
  };
}

describe("createRouter", () => {
  test("initialize echoes protocolVersion and reports tools capability", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(res).not.toBeNull();
    expect(res?.id).toBe(1);
    expect((res?.result as any).protocolVersion).toBe("2024-11-05");
    expect((res?.result as any).capabilities.tools).toEqual({});
  });

  test("initialize defaults protocolVersion when the client omits it", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(typeof (res?.result as any).protocolVersion).toBe("string");
  });

  test("notifications/initialized returns null (no response for a notification)", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
  });

  test("any method with no id (a true notification) returns null, even an unknown one", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({ jsonrpc: "2.0", method: "some/notification" });
    expect(res).toBeNull();
  });

  test("ping replies with an empty result", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(res?.result).toEqual({});
  });

  test("tools/list returns exactly the three metamux tools", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = ((res?.result as any).tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["metamux_current", "metamux_open", "metamux_workspaces"]);
    expect(METAMUX_MCP_TOOLS.length).toBe(3);
  });

  test("tools/call dispatches to the named handler with its arguments", async () => {
    let receivedArgs: unknown = null;
    const handle = createRouter(
      makeHandlers({
        metamux_open: async (args) => {
          receivedArgs = args;
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    );
    const res = await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "metamux_open", arguments: { url: "https://x.test" } },
    });
    expect(receivedArgs).toEqual({ url: "https://x.test" });
    expect((res?.result as any).content[0].text).toBe("ok");
  });

  test("tools/call with an unknown tool name is a normal response with isError:true, not a protocol error", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nonexistent_tool" } });
    expect(res?.error).toBeUndefined();
    expect((res?.result as any).isError).toBe(true);
  });

  test("a tool handler that throws is caught and reported as isError:true (tolerant errors)", async () => {
    const handle = createRouter(
      makeHandlers({
        metamux_current: async () => {
          throw new Error("daemon unreachable");
        },
      }),
    );
    const res = await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "metamux_current" } });
    expect(res?.error).toBeUndefined();
    expect((res?.result as any).isError).toBe(true);
    expect((res?.result as any).content[0].text).toContain("daemon unreachable");
  });

  test("an unknown top-level RPC method returns a JSON-RPC -32601 protocol error", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({ jsonrpc: "2.0", id: 7, method: "totally/unknown" });
    expect(res?.error?.code).toBe(-32601);
  });

  test("never throws on a malformed params object", async () => {
    const handle = createRouter(makeHandlers());
    const res = await handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: "not-an-object" as unknown as Record<string, unknown>,
    });
    expect(res).not.toBeNull();
    expect((res?.result as any).isError).toBe(true);
  });
});
