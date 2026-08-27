#!/usr/bin/env bun
// Permanent debugging harness: connects to the actuator WS as client "fake",
// prints the sync snapshot and then every event with timestamp deltas.
// Exits cleanly on SIGINT.

import { loadConfig } from "../daemon/src/config.ts";
import { secretPath } from "../daemon/src/paths.ts";

async function loadToken(): Promise<string> {
  const text = await Bun.file(secretPath()).text();
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty secret file -- start the daemon at least once");
  return trimmed;
}

async function main() {
  const config = await loadConfig();
  const token = await loadToken();
  const url = `ws://127.0.0.1:${config.port}/actuator`;

  console.log(`fake-extension: connecting to ${url}`);
  const ws = new WebSocket(url);

  let lastTs = Date.now();

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", token, protocol: 1, client: "fake" }));
  });

  ws.addEventListener("message", (event) => {
    const now = Date.now();
    const deltaMs = now - lastTs;
    lastTs = now;

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      console.log(`[+${deltaMs}ms] <unparseable message> ${event.data}`);
      return;
    }
    const obj = parsed as Record<string, unknown>;

    if (obj.type === "sync") {
      console.log(`[+${deltaMs}ms] sync snapshot: seq=${obj.seq}`);
      console.log(`  config: ${JSON.stringify(obj.config)}`);
      console.log(`  state: ${JSON.stringify(obj.state, null, 2)}`);
      return;
    }
    if (obj.type === "event") {
      console.log(`[+${deltaMs}ms] event seq=${obj.seq} name=${obj.name} ${JSON.stringify(obj.workspace)}${obj.url ? ` url=${obj.url}` : ""}`);
      return;
    }
    console.log(`[+${deltaMs}ms] ${JSON.stringify(obj)}`);
  });

  ws.addEventListener("close", (event) => {
    console.log(`fake-extension: connection closed (code=${event.code}, reason=${event.reason || "none"})`);
    process.exit(event.code === 4001 ? 1 : 0);
  });

  ws.addEventListener("error", (event) => {
    console.error(`fake-extension: websocket error`, event);
  });

  process.on("SIGINT", () => {
    console.log("\nfake-extension: exiting");
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
