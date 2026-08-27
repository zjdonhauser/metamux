import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tailer } from "../src/tail.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Tailer", () => {
  test("readAll returns the full initial content as lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-tail-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, 'line1\nline2\nline3\n');
    const tailer = new Tailer(file);
    const lines = await tailer.readAll();
    expect(lines).toEqual(["line1", "line2", "line3"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("readAll on a missing file returns no lines (not a throw)", async () => {
    const tailer = new Tailer("/nonexistent/does/not/exist.jsonl");
    const lines = await tailer.readAll();
    expect(lines).toEqual([]);
  });

  test("start() delivers appended lines incrementally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-tail-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, "seed1\n");
    const tailer = new Tailer(file);
    await tailer.readAll();

    const received: string[] = [];
    tailer.start((lines) => received.push(...lines));

    await writeFile(file, "seed1\nappended1\nappended2\n");

    // poll fallback fires every 300ms; give it margin.
    const deadline = Date.now() + 2000;
    while (received.length < 2 && Date.now() < deadline) {
      await sleep(50);
    }

    tailer.stop();
    expect(received).toEqual(["appended1", "appended2"]);
    await rm(dir, { recursive: true, force: true });
  }, 5000);

  test("rotation: reopens from 0 when the file is truncated/replaced (smaller size or new inode)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-tail-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, "old1\nold2\nold3\n");
    const tailer = new Tailer(file);
    await tailer.readAll();

    const received: string[] = [];
    tailer.start((lines) => received.push(...lines));

    // simulate rotation: remove and recreate with fresh (shorter) content
    await unlink(file);
    await writeFile(file, "new1\n");

    const deadline = Date.now() + 2000;
    while (received.length < 1 && Date.now() < deadline) {
      await sleep(50);
    }

    tailer.stop();
    // must NOT be a suffix-diff against the old offset (which would yield
    // nothing since new1\n is shorter than the old offset) -- it must
    // detect rotation and re-read from 0.
    expect(received).toEqual(["new1"]);
    await rm(dir, { recursive: true, force: true });
  }, 5000);

  test("stop() halts delivery of further lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metamux-tail-"));
    const file = join(dir, "events.jsonl");
    await writeFile(file, "seed\n");
    const tailer = new Tailer(file);
    await tailer.readAll();

    const received: string[] = [];
    tailer.start((lines) => received.push(...lines));
    tailer.stop();

    await writeFile(file, "seed\nafter-stop\n");
    await sleep(600);

    expect(received).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  }, 3000);
});
