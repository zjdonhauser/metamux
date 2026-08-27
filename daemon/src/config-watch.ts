// Watches ~/.config/metamux/config.json for changes: fs.watch on the
// parent dir + a poll fallback, same pattern as tail.ts. Reloads via the
// existing tolerant loadConfig() and calls back only when the reloaded
// config actually differs from what was last seen (by content, not
// reference -- a rewrite with identical content is not a change).

import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, type MetamuxConfig } from "./config.ts";

const POLL_INTERVAL_MS = 500;

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private stopped = false;
  private lastSerialized: string;

  constructor(private configPath: string, current: MetamuxConfig) {
    this.lastSerialized = JSON.stringify(current);
  }

  private async check(onChange: (next: MetamuxConfig) => void): Promise<void> {
    if (this.reading || this.stopped) return;
    this.reading = true;
    try {
      const next = await loadConfig(this.configPath);
      const serialized = JSON.stringify(next);
      if (serialized !== this.lastSerialized) {
        this.lastSerialized = serialized;
        if (!this.stopped) onChange(next);
      }
    } finally {
      this.reading = false;
    }
  }

  start(onChange: (next: MetamuxConfig) => void): void {
    this.stopped = false;
    const flush = () => void this.check(onChange);

    try {
      this.watcher = watch(dirname(this.configPath), () => flush());
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
