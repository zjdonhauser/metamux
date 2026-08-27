import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

// Integration test: spawns the REAL `bun cli/metamux.ts mcp` subprocess and
// drives it over real stdio JSON-RPC. The daemon's HTTP layer is mocked
// with a throwaway Bun.serve standing in for GET /state -- this exercises
// the real subprocess, the real stdio transport, and the real HTTP-bridge
// code path in mcp-server.ts, without needing a full cmux-tailing daemon.

const CLI_PATH = join(import.meta.dir, "..", "..", "cli", "metamux.ts");
const FAKE_TOKEN = "test-token-abc123";

const FAKE_STATE = {
  activeId: "mw_test0001",
  workspaces: [
    {
      id: "mw_test0001",
      title: "test-workspace",
      cwd: "/tmp/metamux-test",
      source: "cmux",
      sourceId: "SRC-0001",
      archived: false,
      updatedAt: new Date().toISOString(),
      ports: [4000],
    },
    {
      id: "mw_test0002",
      title: "archived-workspace",
      cwd: "/tmp/metamux-archived",
      source: "cmux",
      sourceId: "SRC-0002",
      archived: true,
      updatedAt: new Date().toISOString(),
      ports: [],
    },
  ],
};

let fakeServer: ReturnType<typeof Bun.serve>;
let fakePort: number;
let openRequests: unknown[] = [];

beforeAll(() => {
  fakeServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/state" && req.method === "GET") {
        if (url.searchParams.get("token") !== FAKE_TOKEN) {
          return new Response(JSON.stringify({ ok: false }), { status: 401 });
        }
        return Response.json(FAKE_STATE);
      }
      if (url.pathname === "/open" && req.method === "POST") {
        const body = await req.json();
        openRequests.push(body);
        return Response.json({ ok: true, workspace: "mw_test0001" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  fakePort = fakeServer.port!;
});

afterAll(() => {
  fakeServer.stop(true);
});

interface JsonRpcLineReader {
  next(): Promise<Record<string, unknown>>;
}

function makeLineReader(stream: ReadableStream<Uint8Array>): JsonRpcLineReader {
  const reader = stream.getReader();
  let buffer = "";
  const decoder = new TextDecoder();

  return {
    async next(): Promise<Record<string, unknown>> {
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim().length > 0) return JSON.parse(line);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("subprocess stdout closed before a response line arrived");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

describe("metamux mcp (real subprocess, real stdio)", () => {
  test("initialize -> tools/list -> tools/call metamux_current", async () => {
    const child = Bun.spawn(["bun", CLI_PATH, "mcp"], {
      env: { ...process.env, METAMUX_PORT: String(fakePort), METAMUX_TOKEN: FAKE_TOKEN },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdin = child.stdin;
    const reader = makeLineReader(child.stdout as ReadableStream<Uint8Array>);

    try {
      // 1. initialize
      stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n",
      );
      const initRes = await reader.next();
      expect(initRes.id).toBe(1);
      expect((initRes.result as any).protocolVersion).toBe("2024-11-05");
      expect((initRes.result as any).capabilities.tools).toEqual({});

      // 2. notifications/initialized -- no response expected, don't wait for one
      stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      // 3. tools/list
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      const listRes = await reader.next();
      const names = ((listRes.result as any).tools as { name: string }[]).map((t) => t.name).sort();
      expect(names).toEqual(["metamux_current", "metamux_open", "metamux_workspaces"]);

      // 4. tools/call metamux_current -- bridges to the fake /state
      stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "metamux_current", arguments: {} } }) +
          "\n",
      );
      const currentRes = await reader.next();
      const currentContent = (currentRes.result as any).content[0].text;
      const current = JSON.parse(currentContent);
      expect(current.id).toBe("mw_test0001");
      expect(current.title).toBe("test-workspace");
      expect(current.cwd).toBe("/tmp/metamux-test");
      expect(current.ports).toEqual([4000]);

      // 5. tools/call metamux_workspaces -- filters out the archived one
      stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "metamux_workspaces", arguments: {} } }) +
          "\n",
      );
      const workspacesRes = await reader.next();
      const workspaces = JSON.parse((workspacesRes.result as any).content[0].text);
      expect(workspaces.length).toBe(1);
      expect(workspaces[0].id).toBe("mw_test0001");

      // 6. tools/call metamux_open -- bridges to the fake POST /open
      stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "metamux_open", arguments: { url: "https://example.test" } },
        }) + "\n",
      );
      const openRes = await reader.next();
      expect((openRes.result as any).isError).toBeUndefined();
      expect(openRequests.length).toBe(1);
      expect((openRequests[0] as any).url).toBe("https://example.test");
    } finally {
      stdin.end();
      child.kill();
      await child.exited;
    }
  }, 15000);
});
