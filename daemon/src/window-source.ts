// Supervises the tier-1 window helper and feeds its snapshots into WindowPairing.
//
// The helper is a child process rather than something posting to an HTTP
// endpoint: its lifetime is then tied to the daemon, it leaves no orphan, needs
// no install step, and adds no authenticated surface.
//
// Degradation is the whole point. If the helper cannot start, dies, or stalls,
// WindowPairing goes stale and every caller falls back to marker-tab identity.
// That is a loud downgrade to today's behavior, never a silent wrong answer.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { WindowPairing } from "./window-pairing.ts";
import type { CGWindow, ChromeWindow, Display } from "./window-join.ts";

interface RawSnapshot {
  windows: { id: number; owner: string; x: number; y: number; w: number; h: number }[];
  displays: { id: number; x: number; y: number; w: number; h: number }[];
}

const RESTART_DELAY_MS = 5_000;
const POLL_SECONDS = 1;

export class WindowSource {
  readonly pairing = new WindowPairing();
  private child: ChildProcess | null = null;
  private stopped = false;
  private buffer = "";
  /** Chrome's own reported bounds, refreshed by the extension's state frame.
   * Without these a pair still resolves, just with a null chromeWindowId. */
  private chromeWindows: ChromeWindow[] = [];
  /** Log only on change: the helper reports at 1 Hz and an unchanged pairing is
   * not worth a line per second in daemon.log. */
  private lastSummary = "";

  constructor(
    private readonly repoDir: string,
    private readonly stateDir: string,
    private readonly log: (line: string) => void,
  ) {}

  setChromeWindows(windows: ChromeWindow[]): void {
    this.chromeWindows = windows;
  }

  start(): void {
    this.stopped = false;
    this.spawnHelper();
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }

  /** Compile once and run the binary. `swift file.swift` works, but it keeps a
   * ~150MB swift-frontend interpreter resident for the daemon's whole life to
   * poll a window list once a second. The compiled binary is a few MB.
   * Recompiles when the source is newer; falls back to interpreting if swiftc
   * is unavailable or the build fails. */
  private helperCommand(): { cmd: string; args: string[] } {
    const script = `${this.repoDir}/window-source/metamux-windows.swift`;
    const binary = `${this.stateDir}/metamux-windows`;
    const interpret = { cmd: "swift", args: [script, "--watch", String(POLL_SECONDS)] };
    const run = { cmd: binary, args: ["--watch", String(POLL_SECONDS)] };

    try {
      const fresh = existsSync(binary) && statSync(binary).mtimeMs >= statSync(script).mtimeMs;
      if (fresh) return run;
      const built = spawnSync("swiftc", ["-O", "-o", binary, script], { stdio: "ignore" });
      if (built.status === 0 && existsSync(binary)) {
        this.log("[window-source] compiled helper binary");
        return run;
      }
      this.log("[window-source] swiftc unavailable or failed; interpreting instead (uses more memory)");
    } catch (err) {
      this.log(`[window-source] compile check failed, interpreting instead: ${err}`);
    }
    return interpret;
  }

  private spawnHelper(): void {
    if (this.stopped) return;
    const { cmd, args } = this.helperCommand();
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.log(`[window-source] spawn failed, pairing disabled: ${err}`);
      return;
    }
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.log(`[window-source] stderr: ${text.slice(0, 300)}`);
    });
    child.on("exit", (code) => {
      if (this.stopped) return;
      this.log(`[window-source] helper exited (${code}); pairing degrades to marker tab, retrying in ${RESTART_DELAY_MS}ms`);
      this.child = null;
      setTimeout(() => this.spawnHelper(), RESTART_DELAY_MS);
    });
  }

  private logOnChange(windows: CGWindow[]): void {
    const seen = windows.map((w) => `${w.owner}#${w.id}`).sort().join(",");
    const health = this.pairing.healthy ? "healthy" : "FALLBACK";
    const violations = this.pairing.violations.map((v) => `${v.kind}:${v.owner}@${v.displayId}`).join(",");
    const summary = `${health} [${seen}]${violations ? " " + violations : ""}`;
    if (summary === this.lastSummary) return;
    this.lastSummary = summary;
    this.log(`[window-pairing] ${summary}`);
  }

  private consume(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: RawSnapshot;
      try {
        raw = JSON.parse(trimmed) as RawSnapshot;
      } catch {
        continue; // Never throw on a partial or malformed frame.
      }
      const windows: CGWindow[] = (raw.windows ?? []).map((w) => ({
        id: w.id,
        owner: w.owner,
        bounds: { x: w.x, y: w.y, w: w.w, h: w.h },
      }));
      const displays: Display[] = (raw.displays ?? []).map((d) => ({
        id: d.id,
        bounds: { x: d.x, y: d.y, w: d.w, h: d.h },
      }));
      this.pairing.ingest(windows, this.chromeWindows, displays);
      this.logOnChange(windows);
    }
  }
}
