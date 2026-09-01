#!/usr/bin/env bun
/**
 * Shows what the identity-model cutover would do. Changes nothing.
 *
 * The cutover discards the old registry rather than migrating it, so the one
 * thing worth seeing beforehand is which existing tab groups re-link to a live
 * tmux session by label, and which stop being managed.
 *
 * Usage: bun scripts/cutover-preflight.ts
 */
import { listSessions } from "../daemon/src/model/tmux-source.ts";
import { projectWorkspaces } from "../daemon/src/model/project-workspaces.ts";
import { parseStoreText } from "../daemon/src/model/store.ts";
import { registryPath } from "../daemon/src/paths.ts";
import { readFileSync } from "node:fs";

function oldRegistryTitles(): string[] {
  try {
    const raw = JSON.parse(readFileSync(registryPath(), "utf8")) as { workspaces?: { title?: string; archived?: boolean }[] };
    return (raw.workspaces ?? [])
      .filter((w) => !w.archived && typeof w.title === "string")
      .map((w) => w.title as string);
  } catch {
    return [];
  }
}

const sessions = listSessions();
if (sessions.length === 0) {
  console.log("No tmux sessions. After cutover metamux would manage nothing at all.");
  process.exit(0);
}

let minted = 0;
const { workspaces, toStamp } = projectWorkspaces(sessions, parseStoreText("").workspaces, () => `mw_preflight_${++minted}`);
const live = workspaces.filter((w) => !w.archived);
const liveLabels = new Set(live.map((w) => w.label));

const oldTitles = oldRegistryTitles();
const uniqueOld = [...new Set(oldTitles)];
const relinks = uniqueOld.filter((t) => liveLabels.has(t));
const orphans = uniqueOld.filter((t) => !liveLabels.has(t));
const duplicates = oldTitles.length - uniqueOld.length;

console.log(`tmux sessions              : ${sessions.length}`);
console.log(`workspaces after cutover   : ${live.length}`);
console.log(`ids to stamp on first run  : ${toStamp.length}`);
console.log("");
console.log(`old registry, non-archived : ${oldTitles.length} rows (${uniqueOld.length} unique titles, ${duplicates} duplicate rows)`);
console.log(`  re-link by label         : ${relinks.length}`);
console.log(`  become unmanaged         : ${orphans.length}`);

console.log("\nWorkspaces after cutover:");
for (const w of live) {
  const mark = relinks.includes(w.label) ? "re-links to an existing group" : "starts with a fresh group";
  console.log(`  ${w.label.padEnd(24)} ${mark}`);
}

if (orphans.length > 0) {
  console.log("\nNo longer managed (no tmux session backs these):");
  for (const t of orphans) console.log(`  ${t}`);
  console.log("\nTheir tabs are left alone. metamux stops managing the group, it does not close it.");
}

const noHarness = sessions.filter((s) => s.metamuxId === null).length;
if (noHarness > 0) {
  console.log(`\n${noHarness} session(s) carry no @metamux_id yet and get one stamped on first run.`);
}
console.log("\nNothing was changed by this preflight.");
