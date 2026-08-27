// Tails a JSONL file: initial full read, then incremental reads driven by
// fs.watch plus a 300ms polling fallback. Reopens from 0 on truncation or
// inode change (log rotation).

import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

const POLL_INTERVAL_MS = 300;

export class Tailer {
  private offset = 0;
  private inode: number | null = null;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private stopped = false;

  constructor(private filePath: string) {}

  /** Full read of the current file. Seeds offset/inode tracking. Missing
   * file is not an error -- returns no lines. */
  async readAll(): Promise<string[]> {
    this.offset = 0;
    this.inode = null;
    return this.readFrom(0);
  }

  private async readFrom(offset: number): Promise<string[]> {
    let info;
    try {
      info = await stat(this.filePath);
    } catch {
      return [];
    }
    this.inode = info.ino;
    if (info.size <= offset) {
      this.offset = info.size;
      return [];
    }
    const slice = Bun.file(this.filePath).slice(offset, info.size);
    const text = await slice.text();
    this.offset = info.size;
    return text.split("\n").filter((line) => line.length > 0);
  }

  /** One poll cycle: detects rotation (size < offset or inode changed) and
   * reopens from 0 if so, otherwise reads only the newly appended bytes. */
  async poll(): Promise<string[]> {
    if (this.reading) return [];
    this.reading = true;
    try {
      let info;
      try {
        info = await stat(this.filePath);
      } catch {
        return [];
      }
      const rotated = (this.inode !== null && info.ino !== this.inode) || info.size < this.offset;
      if (rotated) {
        this.offset = 0;
      }
      return await this.readFrom(this.offset);
    } finally {
      this.reading = false;
    }
  }

  /** Start incremental tailing. onLines is called with each non-empty
   * batch of new lines, in order, as they're discovered. */
  start(onLines: (lines: string[]) => void): void {
    this.stopped = false;
    const flush = () => {
      if (this.stopped) return;
      this.poll().then((lines) => {
        if (!this.stopped && lines.length > 0) onLines(lines);
      });
    };

    try {
      this.watcher = watch(dirname(this.filePath), () => flush());
    } catch {
      this.watcher = null; // fs.watch unavailable -- polling fallback still covers us
    }
    this.pollTimer = setInterval(flush, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
