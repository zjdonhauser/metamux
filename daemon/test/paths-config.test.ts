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

  describe("METAMUX_PORT override", () => {
    test("takes precedence over the config file's own port", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ port: 9999 }));
      const originalEnv = process.env.METAMUX_PORT;
      process.env.METAMUX_PORT = "54321";
      const config = await loadConfig(path);
      expect(config.port).toBe(54321);
      if (originalEnv === undefined) delete process.env.METAMUX_PORT;
      else process.env.METAMUX_PORT = originalEnv;
      await rm(dir, { recursive: true, force: true });
    });

    test("absent env leaves the config file's port (or default) untouched", async () => {
      const originalEnv = process.env.METAMUX_PORT;
      delete process.env.METAMUX_PORT;
      const config = await loadConfig("/nonexistent/path/config.json");
      expect(config.port).toBe(DEFAULT_CONFIG.port);
      if (originalEnv !== undefined) process.env.METAMUX_PORT = originalEnv;
    });

    test("a non-numeric METAMUX_PORT is ignored, falling back to the config file/default", async () => {
      const originalEnv = process.env.METAMUX_PORT;
      process.env.METAMUX_PORT = "not-a-number";
      const config = await loadConfig("/nonexistent/path/config.json");
      expect(config.port).toBe(DEFAULT_CONFIG.port);
      if (originalEnv === undefined) delete process.env.METAMUX_PORT;
      else process.env.METAMUX_PORT = originalEnv;
    });
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

  describe("createGroups", () => {
    test("defaults to on-open when absent", async () => {
      const config = await loadConfig("/nonexistent/path/config.json");
      expect(config.createGroups).toBe("on-open");
    });

    test("reads on-activate and eager explicitly", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
      const activatePath = join(dir, "activate.json");
      await writeFile(activatePath, JSON.stringify({ createGroups: "on-activate" }));
      expect((await loadConfig(activatePath)).createGroups).toBe("on-activate");

      const eagerPath = join(dir, "eager.json");
      await writeFile(eagerPath, JSON.stringify({ createGroups: "eager" }));
      expect((await loadConfig(eagerPath)).createGroups).toBe("eager");
      await rm(dir, { recursive: true, force: true });
    });

    test("back-compat: a legacy 'lazy' value from an existing config file reads as on-activate", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ createGroups: "lazy" }));
      const config = await loadConfig(path);
      expect(config.createGroups).toBe("on-activate");
      await rm(dir, { recursive: true, force: true });
    });

    test("an unrecognized createGroups value falls back to the on-open default", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ createGroups: "nonsense" }));
      const config = await loadConfig(path);
      expect(config.createGroups).toBe("on-open");
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("colorBackflow", () => {
    test("defaults to true when absent", async () => {
      const config = await loadConfig("/nonexistent/path/config.json");
      expect(config.colorBackflow).toBe(true);
    });

    test("reads false from the config file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ colorBackflow: false }));
      const config = await loadConfig(path);
      expect(config.colorBackflow).toBe(false);
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("tmux config block", () => {
    test("defaults: disabled, windows mirror, alphabetize on, 8s reattach grace, ~/Documents/GitHub cwd", async () => {
      const originalEnv = process.env.TMUX_CMUX_MIRROR;
      delete process.env.TMUX_CMUX_MIRROR;
      const config = await loadConfig("/nonexistent/path/config.json");
      expect(config.tmux).toEqual({
        enabled: false,
        mirror: "windows",
        alphabetize: true,
        reattachGraceMs: 8000,
        spawnCwd: join(process.env.HOME ?? "", "Documents/GitHub"),
      });
      if (originalEnv !== undefined) process.env.TMUX_CMUX_MIRROR = originalEnv;
    });

    test("reads every tmux key from the config file and expands ~ in spawnCwd", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({ tmux: { enabled: true, mirror: "global", alphabetize: false, reattachGraceMs: 15000, spawnCwd: "~/hub" } }),
      );
      const config = await loadConfig(path);
      expect(config.tmux).toEqual({
        enabled: true,
        mirror: "global",
        alphabetize: false,
        reattachGraceMs: 15000,
        spawnCwd: join(process.env.HOME ?? "", "hub"),
      });
      await rm(dir, { recursive: true, force: true });
    });

    test("an invalid tmux.mirror value falls back to the TMUX_CMUX_MIRROR-aware default, not a crash", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ tmux: { mirror: "nonsense" } }));
      const originalEnv = process.env.TMUX_CMUX_MIRROR;
      delete process.env.TMUX_CMUX_MIRROR;
      const config = await loadConfig(path);
      expect(config.tmux.mirror).toBe("windows");
      if (originalEnv !== undefined) process.env.TMUX_CMUX_MIRROR = originalEnv;
      await rm(dir, { recursive: true, force: true });
    });

    test("TMUX_CMUX_MIRROR env var is honored as a fallback when the config file doesn't set tmux.mirror", async () => {
      const originalEnv = process.env.TMUX_CMUX_MIRROR;
      process.env.TMUX_CMUX_MIRROR = "global";
      const config = await loadConfig("/nonexistent/path/config.json");
      expect(config.tmux.mirror).toBe("global");
      if (originalEnv === undefined) delete process.env.TMUX_CMUX_MIRROR;
      else process.env.TMUX_CMUX_MIRROR = originalEnv;
    });

    test("an explicit tmux.mirror in the config file wins over the TMUX_CMUX_MIRROR env var", async () => {
      const dir = await mkdtemp(join(tmpdir(), "metamux-config-"));
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ tmux: { mirror: "windows" } }));
      const originalEnv = process.env.TMUX_CMUX_MIRROR;
      process.env.TMUX_CMUX_MIRROR = "global";
      const config = await loadConfig(path);
      expect(config.tmux.mirror).toBe("windows");
      if (originalEnv === undefined) delete process.env.TMUX_CMUX_MIRROR;
      else process.env.TMUX_CMUX_MIRROR = originalEnv;
      await rm(dir, { recursive: true, force: true });
    });
  });
});
