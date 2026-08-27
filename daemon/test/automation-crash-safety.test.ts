import { describe, expect, test } from "bun:test";
import { ActuatorServer } from "../src/server.ts";
import { DEFAULT_CONFIG, type MetamuxConfig } from "../src/config.ts";
import { GroupProjection } from "../src/group-projection.ts";
import { LazyGroupTracker } from "../src/lazy-groups.ts";
import { Registry } from "../src/registry.ts";

// Real Bun.serve() on an ephemeral port, real fetch, real WebSocket --
// unlike the rest of server.test.ts (private-method casts, no real port),
// this specifically proves the daemon survives adversarial input at the
// actual wire boundary, matching what actually killed it in production
// (docs/protocol.md, "Process-level crash safety net"). Bun.serve's
// `fetch:` callback was already proven safe (a throw there just produces
// a 500); the `websocket.message` callback was NOT, before the try/catch
// this test guards.

function cfg(overrides: Partial<MetamuxConfig> = {}): MetamuxConfig {
  return { ...DEFAULT_CONFIG, ports: { ...DEFAULT_CONFIG.ports }, ...overrides };
}

async function startRealServer(config: MetamuxConfig) {
  const registry = new Registry();
  registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
  registry.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "cmux", cwd: "/a", bootId: "B1", seq: 2, occurredAtMs: 2 });

  const server = new ActuatorServer({
    port: 0, // ephemeral -- Bun picks a free port
    secret: "test-secret",
    registry,
    config,
    cursor: { bootId: "B1", seq: 1 },
    stats: { skippedLines: 0 },
    groupProjection: new GroupProjection(config.groupBy),
    lazyGroups: new LazyGroupTracker(),
    log: () => {}, // quiet -- this test asserts on HTTP responses, not log lines
  });
  server.start();
  const port = (server as unknown as { server: { port: number } }).server.port;
  return { server, port };
}

async function getStatus(port: number, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/status?token=${token}`, { signal: AbortSignal.timeout(2000) });
}

async function postAutomation(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/automation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
}

describe("ActuatorServer -- real-server crash safety (POST /automation)", () => {
  test("a batch of malformed/adversarial automation requests all get 4xx/5xx, and /status still answers after every one", async () => {
    const { server, port } = await startRealServer(cfg({ agentBrowser: "full" }));
    try {
      const cases: unknown[] = [
        "{not valid json at all",
        { token: "test-secret", op: "not-an-object" },
        { token: "test-secret", op: {} },
        { token: "test-secret", op: { kind: "navigate", url: "not a url" } },
        { token: "test-secret", op: { kind: "navigate", url: "http://" } },
        { token: "test-secret", op: { kind: "navigate", url: 12345 } },
        { token: "test-secret", op: { kind: "navigate" } },
        { token: "test-secret", op: { kind: "bogus-op-kind" } },
        { token: "wrong-token", op: { kind: "tabContext" } },
        { token: "test-secret", workspaceId: "mw_totally_unknown", op: { kind: "tabContext" } },
        {}, // no token, no op at all
        { token: "test-secret" }, // no op
        { token: "test-secret", op: null },
      ];

      for (const body of cases) {
        const res = await postAutomation(port, body);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(600);

        const statusRes = await getStatus(port, "test-secret");
        expect(statusRes.ok).toBe(true);
      }
    } finally {
      server.stop();
    }
  });

  test("a fake 'extension' WS client sending malformed automationResponse frames doesn't kill the server", async () => {
    const { server, port } = await startRealServer(cfg({ agentBrowser: "full" }));
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/actuator`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "hello", token: "test-secret", protocol: 1, client: "extension" }));
          resolve();
        };
        ws.onerror = () => reject(new Error("ws failed to open"));
      });
      await new Promise((r) => setTimeout(r, 200));

      // Every one of these is a plausible malformed/adversarial frame a
      // buggy or malicious extension-side script could send.
      const garbageFrames = [
        "not even json",
        JSON.stringify({ type: "automationResponse" }), // no id
        JSON.stringify({ type: "automationResponse", id: 12345, ok: true, result: {} }), // id not a string
        JSON.stringify({ type: "automationResponse", id: "unknown-id", ok: true, result: { a: 1 } }), // unknown id
        JSON.stringify({ type: "automationResponse", id: "x", ok: "not-a-boolean", result: null }),
        JSON.stringify({ type: "automationResponse", id: "x", ok: false }), // no error field
        JSON.stringify(null),
        JSON.stringify([1, 2, 3]),
        JSON.stringify({ type: 12345 }), // type not a string
      ];
      for (const frame of garbageFrames) {
        ws.send(frame);
      }
      await new Promise((r) => setTimeout(r, 300));

      const statusRes = await getStatus(port, "test-secret");
      expect(statusRes.ok).toBe(true);

      ws.close();
    } finally {
      server.stop();
    }
  });
});
