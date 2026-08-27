// State/config path resolution, atomic JSON writes, and secret management.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// METAMUX_STATE_DIR / METAMUX_CONFIG_PATH: tolerant overrides (real
// isolation for scripts/e2e-chromium.ts and other throwaway daemon runs --
// without them, a spawned test daemon would read/write Zac's real
// registry.json/cursor.json/secret/daemon.log/config.json, live-affecting
// his actual running system). Absent env -> the normal, unchanged default.
export const STATE_DIR = expandHome(process.env.METAMUX_STATE_DIR || "~/.local/state/metamux");
export const CONFIG_PATH = expandHome(process.env.METAMUX_CONFIG_PATH || "~/.config/metamux/config.json");

export function registryPath(): string {
  return join(STATE_DIR, "registry.json");
}

export function cursorPath(): string {
  return join(STATE_DIR, "cursor.json");
}

export function secretPath(): string {
  return join(STATE_DIR, "secret");
}

export function logPath(): string {
  return join(STATE_DIR, "daemon.log");
}

export async function ensureStateDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}

/** Atomic write via tmp file + rename (same directory, same filesystem). */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/")) || ".";
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

/** 32 hex chars, mode 0600, generated on first daemon start (create-if-missing). */
export async function ensureSecret(): Promise<string> {
  await ensureStateDir();
  const p = secretPath();
  try {
    const existing = (await readFile(p, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch {
    // doesn't exist yet -- fall through to create
  }
  const secret = randomBytes(16).toString("hex"); // 32 hex chars
  const dir = STATE_DIR;
  const tmp = join(dir, `.tmp-secret-${process.pid}-${Date.now()}`);
  await writeFile(tmp, secret, { mode: 0o600 });
  await rename(tmp, p);
  await chmod(p, 0o600);
  return secret;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
