#!/usr/bin/env bun
// Real-Chromium end-to-end smoke test for the metamux extension.
// Spawns the daemon, launches the cached Playwright Chromium with the
// extension loaded unpacked, drives the options page, then flicks a real
// cmux workspace switch and asserts the tab groups follow it.
//
// NEVER touches Zac's real Google Chrome or its profile: only the cached
// Playwright Chromium build, in a throwaway profile dir under /tmp.
//
// Usage: bun scripts/e2e-chromium.ts

import { chromium } from "playwright-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const EXTENSION_DIR = path.join(REPO_ROOT, "extension");
const SECRET_PATH = path.join(homedir(), ".local/state/metamux/secret");
const PORT = 8377;
const CHROMIUM_EXECUTABLE = path.join(
  homedir(),
  "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);

interface AssertionResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: AssertionResult[] = [];

function record(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? `: ${detail}` : ""}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(secret: string, timeoutMs = 10000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/status?token=${secret}`);
      if (res.ok) return await res.json();
    } catch {
      // daemon not up yet
    }
    await sleep(200);
  }
  throw new Error(`daemon /status did not respond within ${timeoutMs}ms`);
}

async function getState(secret: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${PORT}/state?token=${secret}`);
  if (!res.ok) throw new Error(`GET /state failed: ${res.status}`);
  return res.json();
}

async function main() {
  let daemonProc = null;
  let context = null;
  let tmpProfileDir = null;

  try {
    const secret = (await readFile(SECRET_PATH, "utf8")).trim();

    console.log("--- starting daemon ---");
    daemonProc = Bun.spawn(["bun", "daemon/src/main.ts"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const status = await waitForStatus(secret);
    console.log("daemon /status:", JSON.stringify(status));

    console.log("--- launching Chromium with extension loaded ---");
    tmpProfileDir = await mkdtemp(path.join(tmpdir(), "metamux-e2e-"));
    context = await chromium.launchPersistentContext(tmpProfileDir, {
      headless: false,
      executablePath: CHROMIUM_EXECUTABLE,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });

    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    }
    const extensionId = sw.url().split("/")[2];
    console.log("extension id:", extensionId);

    console.log("--- configuring options page ---");
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await optionsPage.fill("#port", String(PORT));
    await optionsPage.fill("#secret", secret);
    await optionsPage.click("#test");
    await optionsPage.waitForTimeout(1000);
    const testResultText = await optionsPage.textContent("#test-result");
    record("options 'Test connection' reports ok", /ok/i.test(testResultText ?? ""), testResultText ?? "");
    await optionsPage.click("button[type=submit]");
    await optionsPage.waitForTimeout(300);

    console.log("--- waiting for extension to sync groups ---");
    await sleep(3000);

    const state1 = await getState(secret);
    const groups1: chrome.tabGroups.TabGroup[] = await sw.evaluate(() => chrome.tabGroups.query({}));
    console.log(
      "groups after initial sync:",
      groups1.map((g) => ({ title: g.title, color: g.color, collapsed: g.collapsed })),
    );

    const storedState = await sw.evaluate(() => chrome.storage.local.get("metamuxState"));
    const byId: Record<string, any> = storedState.metamuxState?.byId ?? {};
    console.log(
      "byId entries for duplicate-title diagnosis:",
      JSON.stringify(
        Object.entries(byId).filter(([, e]) => e.title === "compliance"),
        null,
        2,
      ),
    );
    const complianceInRegistry = state1.workspaces.filter((w: any) => w.title === "compliance");
    console.log("registry workspaces titled 'compliance':", JSON.stringify(complianceInRegistry, null, 2));

    const liveTitles = new Set(
      state1.workspaces.filter((w: any) => !w.archived).map((w: any) => w.title),
    );
    const matched = groups1.some((g) => liveTitles.has(g.title));
    record(
      "at least one tab group title matches a live cmux workspace",
      matched,
      `groups: [${groups1.map((g) => g.title).join(", ")}]`,
    );

    // Resolve a workspace's real tab group by id -> groupId (via the
    // extension's own mapping), not by title: cmux legitimately allows two
    // different workspaces to share a display title (e.g. same dir name,
    // different cwd), so title alone is ambiguous.
    async function activeGroupFor(activeId: string): Promise<chrome.tabGroups.TabGroup | null> {
      const stored = await sw.evaluate(() => chrome.storage.local.get("metamuxState"));
      const entry = stored.metamuxState?.byId?.[activeId];
      if (!entry || entry.groupId == null) return null;
      const groups = await sw.evaluate(
        (groupId) => chrome.tabGroups.query({}).then((gs) => gs.filter((g) => g.id === groupId)),
        entry.groupId,
      );
      return groups[0] ?? null;
    }

    console.log("--- cmux rpc workspace.next ---");
    Bun.spawnSync(["cmux", "rpc", "workspace.next", "{}"], { cwd: REPO_ROOT });
    await sleep(1500);

    const state2 = await getState(secret);
    const activeGroup2 = await activeGroupFor(state2.activeId);
    record(
      "after workspace.next, the newly active workspace's group is expanded",
      !!activeGroup2 && activeGroup2.collapsed === false,
      `activeId=${state2.activeId}, group=${JSON.stringify(activeGroup2)}`,
    );

    let activeTabInGroup = false;
    if (activeGroup2) {
      const tabs = await sw.evaluate((groupId) => chrome.tabs.query({ groupId }), activeGroup2.id);
      activeTabInGroup = tabs.some((t) => t.active);
    }
    record("after workspace.next, a tab in the active group is the active tab", activeTabInGroup);

    console.log("--- cmux rpc workspace.previous (restoring) ---");
    Bun.spawnSync(["cmux", "rpc", "workspace.previous", "{}"], { cwd: REPO_ROOT });
    await sleep(1500);

    const state3 = await getState(secret);
    const activeGroup3 = await activeGroupFor(state3.activeId);
    record(
      "after workspace.previous, restored workspace's group is expanded again",
      !!activeGroup3 && activeGroup3.collapsed === false,
      `activeId=${state3.activeId}, group=${JSON.stringify(activeGroup3)}`,
    );
  } finally {
    console.log("\n--- cleanup ---");
    if (context) {
      await context.close().catch((err) => console.error("context close error", err));
    }
    if (tmpProfileDir) {
      await rm(tmpProfileDir, { recursive: true, force: true }).catch(() => {});
    }
    if (daemonProc) {
      daemonProc.kill();
      await daemonProc.exited.catch(() => {});
    }
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.name}`);
  }
  const allPass = results.every((r) => r.pass);
  console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e script crashed:", err);
  process.exit(1);
});
