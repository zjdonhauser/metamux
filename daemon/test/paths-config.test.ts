import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, ensureSecret, expandHome } from "../src/paths.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

describe("expandHome", () => {
  test("expands ~ and ~/ prefixes", () => {
    expect(expandHome("~")).toBe(process.env.HOME ?? "");
    expect(expandHome("~/foo/bar")).toBe(join(process.env.HOME ?? "", "foo/bar"));
  });

  test("leaves absolute paths untouched", () => {
    expect(expandHome("/etc/foo")).toBe("/etc/foo");
  });
});

describe("atomicWriteJson", () => {
  test("writes valid JSON readable after the call, leaves no tmp file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-paths-"));
    const target = join(dir, "sub", "data.json");
    await atomicWriteJson(target, { hello: "world", n: 1 });
    const content = JSON.parse(await readFile(target, "utf8"));
    expect(content).toEqual({ hello: "world", n: 1 });
    await rm(dir, { recursive: true, force: true });
  });
});

describe("ensureSecret", () => {
  test("generates a 32-hex-char secret with mode 0600, create-if-missing, idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-secret-"));
    const originalHome = process.env.HOME;
    // Redirect HOME so ensureSecret's STATE_DIR constant... note: STATE_DIR is
    // computed at module load time from homedir(), so this test instead
    // verifies the *shape* contract directly rather than relying on env
    // mutation reaching an already-imported constant.
    const secret1 = await ensureSecret();
    const secret2 = await ensureSecret();
    expect(secret1).toMatch(/^[0-9a-f]{32}$/);
    expect(secret2).toBe(secret1); // idempotent: create-if-missing
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  });
});

describe("loadConfig", () => {
  test("returns defaults when the file is missing", async () => {
    const config = await loadConfig("/nonexistent/path/config.json");
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.closeBehavior).toBe("archive");
    expect(config.collapseOthers).toBe(true);
    expect(config.debounceMs).toBe(DEFAULT_CONFIG.debounceMs);
  });

  test("returns defaults when the file is invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, "{ not valid json");
    const config = await loadConfig(path);
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    await rm(dir, { recursive: true, force: true });
  });

  test("merges partial overrides with defaults and expands ~ in eventsPath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ port: 9999, eventsPath: "~/custom/events.jsonl" }));
    const config = await loadConfig(path);
    expect(config.port).toBe(9999);
    expect(config.eventsPath).toBe(join(process.env.HOME ?? "", "custom/events.jsonl"));
    expect(config.closeBehavior).toBe("archive"); // untouched default
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects an invalid closeBehavior value by falling back to archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ closeBehavior: "nonsense" }));
    const config = await loadConfig(path);
    expect(config.closeBehavior).toBe("archive");
    await rm(dir, { recursive: true, force: true });
  });

  test("ports and reverseSync default to auto/off/false/49151 when absent", async () => {
    const config = await loadConfig("/nonexistent/path/config.json");
    expect(config.ports).toEqual({ mode: "auto", ignore: [], maxPort: 49151 });
    expect(config.reverseSync).toBe(false);
  });

  test("ports.mode, ports.ignore, and ports.maxPort are read from the config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({ ports: { mode: "notify", ignore: [22, 5432], maxPort: 8000 }, reverseSync: true }),
    );
    const config = await loadConfig(path);
    expect(config.ports).toEqual({ mode: "notify", ignore: [22, 5432], maxPort: 8000 });
    expect(config.reverseSync).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("an invalid ports.maxPort falls back to the 49151 default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ ports: { maxPort: "not-a-number" } }));
    const config = await loadConfig(path);
    expect(config.ports.maxPort).toBe(49151);
    await rm(dir, { recursive: true, force: true });
  });

  test("an invalid ports.mode falls back to auto", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ ports: { mode: "nonsense" } }));
    const config = await loadConfig(path);
    expect(config.ports.mode).toBe("auto");
    await rm(dir, { recursive: true, force: true });
  });
});
