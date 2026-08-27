import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigWatcher } from "../src/config-watch.ts";
import { loadConfig } from "../src/config.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ConfigWatcher", () => {
  test("fires onChange with the reloaded config when the file changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-configwatch-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ reverseSync: false }));
    const initial = await loadConfig(path);

    const watcher = new ConfigWatcher(path, initial);
    const seen: boolean[] = [];
    watcher.start((next) => seen.push(next.reverseSync));

    await writeFile(path, JSON.stringify({ reverseSync: true }));

    const deadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < deadline) {
      await sleep(50);
    }

    watcher.stop();
    expect(seen).toEqual([true]);
    await rm(dir, { recursive: true, force: true });
  }, 5000);

  test("does not fire when the file is rewritten with identical content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-configwatch-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ port: 8377 }));
    const initial = await loadConfig(path);

    const watcher = new ConfigWatcher(path, initial);
    const seen: unknown[] = [];
    watcher.start((next) => seen.push(next));

    await writeFile(path, JSON.stringify({ port: 8377 })); // identical after normalization
    await sleep(700); // outlast the poll fallback interval

    watcher.stop();
    expect(seen).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  }, 3000);

  test("stop() halts further onChange calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-configwatch-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ debounceMs: 200 }));
    const initial = await loadConfig(path);

    const watcher = new ConfigWatcher(path, initial);
    const seen: unknown[] = [];
    watcher.start((next) => seen.push(next));
    watcher.stop();

    await writeFile(path, JSON.stringify({ debounceMs: 500 }));
    await sleep(700);

    expect(seen).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  }, 3000);

  test("a missing config file (deleted, falls back to defaults) is tolerated without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-configwatch-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ port: 8377 }));
    const initial = await loadConfig(path);

    const watcher = new ConfigWatcher(path, initial);
    expect(() => watcher.start(() => {})).not.toThrow();
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  });
});
