#!/usr/bin/env bun
// Real-Chromium end-to-end smoke test for the metamux extension.
// Spawns an ISOLATED daemon (own port, own state dir, own config -- see
// "Isolation" below), launches the cached Playwright Chromium with the
// extension loaded unpacked, drives the options page, then exercises
// createGroups: "on-open" (activation creates no group; POST /open does)
// and the tab-group janitor (a pre-created duplicate merges away) against
// it.
//
// NEVER touches Zac's real Google Chrome or its profile: only the cached
// Playwright Chromium build, in a throwaway profile dir under /tmp.
//
// Isolation: the daemon this script spawns NEVER shares a port, state dir,
// or config file with Zac's real, already-running daemon (zshrc-ensured).
// A prior version of this script silently failed to bind port 8377 and
// rode whatever was already listening there -- almost always his live
// daemon, stale relative to the code under test, and a real system to not
// disrupt. METAMUX_PORT / METAMUX_STATE_DIR / METAMUX_CONFIG_PATH (see
// daemon/src/paths.ts, daemon/src/config.ts) give this script a genuinely
// separate daemon instance. The live daemon's PID is asserted UNCHANGED
// before and after this script runs, as direct proof of zero contact.
//
// `cmux rpc workspace.next`/`workspace.previous` still touch Zac's REAL
// cmux workspace focus (read-only from this daemon's perspective -- it
// only tails the same events.jsonl, same as before isolation) and are
// restored at the end, same as every prior version of this script.
//
// Usage: bun scripts/e2e-chromium.ts

import { chromium } from "playwright-core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import net from "node:net";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const EXTENSION_DIR = path.join(REPO_ROOT, "extension");
const DAEMON_ENTRY = path.join(REPO_ROOT, "daemon/src/main.ts");
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

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("could not determine a free port"))));
    });
    server.on("error", reject);
  });
}

/** PIDs of every process whose command line contains this repo's daemon
 * entrypoint -- used to prove zero contact with Zac's real, already-
 * running daemon (same PID set before and after this script runs). */
async function daemonPids(): Promise<string[]> {
  const proc = Bun.spawnSync(["pgrep", "-f", DAEMON_ENTRY]);
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out ? out.split("\n").sort() : [];
}

/** True if something is already answering on this specific port -- any
 * response counts, even a 401, since that still proves a listener is
 * there. A defense-in-depth double-check after getFreePort(): the
 * probe-then-bind window is a real (if narrow) TOCTOU race, and this
 * script must never silently ride a listener it didn't spawn itself
 * (isolation's entire point). */
async function portAlreadyInUse(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(500) });
    void res.status;
    return true;
  } catch {
    return false;
  }
}

async function waitForStatus(port: number, secret: string, timeoutMs = 10000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status?token=${secret}`);
      if (res.ok) return await res.json();
    } catch {
      // daemon not up yet
    }
    await sleep(200);
  }
  throw new Error(`daemon /status did not respond within ${timeoutMs}ms`);
}

async function main() {
  let daemonProc = null;
  let context = null;
  let tmpProfileDir = null;
  let tmpStateDir = null;
  let tmpConfigDir = null;

  const livePidsBefore = await daemonPids();
  console.log(`live daemon PID(s) before this run: [${livePidsBefore.join(", ") || "none"}]`);

  try {
    // --- Isolation setup: own port, own state dir, own config. ---
    const port = await getFreePort();
    if (await portAlreadyInUse(port)) {
      throw new Error(`port ${port} (just probed free) is already answering -- refusing to silently ride an unknown listener. Re-run.`);
    }
    tmpStateDir = await mkdtemp(path.join(tmpdir(), "metamux-e2e-state-"));
    tmpConfigDir = await mkdtemp(path.join(tmpdir(), "metamux-e2e-config-"));
    const configPath = path.join(tmpConfigDir, "config.json");
    // Every behavior-relevant key this e2e depends on is explicit here,
    // not left to DEFAULT_CONFIG, so it keeps testing today's code
    // deterministically even if a default drifts later. collapseOthers:
    // false is ALSO deliberate and load-bearing: this daemon still tails
    // Zac's REAL, live events.jsonl (isolation covers port/state/config,
    // not the event source), so an unrelated background workspace
    // activation elsewhere is a real, observed possibility during this
    // script's run -- with collapseOthers on, that would legitimately
    // (and correctly) collapse the very group this script just opened,
    // making the "is it expanded" assertion flaky for reasons that have
    // nothing to do with the code under test.
    await writeFile(
      configPath,
      JSON.stringify({ createGroups: "on-open", groupBy: "title", janitor: true, collapseOthers: false }),
    );

    console.log(`--- starting ISOLATED daemon (port ${port}, state dir ${tmpStateDir}) ---`);
    daemonProc = Bun.spawn(["bun", DAEMON_ENTRY], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        METAMUX_PORT: String(port),
        METAMUX_STATE_DIR: tmpStateDir,
        METAMUX_CONFIG_PATH: configPath,
      },
    });

    // The isolated daemon generates its own secret on first start, under
    // its own isolated state dir -- wait for it rather than assuming a
    // fixed delay.
    const secretPath = path.join(tmpStateDir, "secret");
    const secretDeadline = Date.now() + 10000;
    let secret = "";
    while (Date.now() < secretDeadline) {
      try {
        secret = (await readFile(secretPath, "utf8")).trim();
        if (secret) break;
      } catch {
        // not written yet
      }
      await sleep(100);
    }
    if (!secret) throw new Error(`isolated daemon never wrote a secret to ${secretPath}`);

    void (async () => {
      if (!daemonProc?.stdout) return;
      for await (const chunk of daemonProc.stdout as ReadableStream<Uint8Array>) {
        process.stdout.write(`[daemon] ${new TextDecoder().decode(chunk)}`);
      }
    })();
    void (async () => {
      if (!daemonProc?.stderr) return;
      for await (const chunk of daemonProc.stderr as ReadableStream<Uint8Array>) {
        process.stderr.write(`[daemon:stderr] ${new TextDecoder().decode(chunk)}`);
      }
    })();

    const status = await waitForStatus(port, secret);
    console.log("isolated daemon /status:", JSON.stringify(status));

    const livePidsDuring = await daemonPids();
    record(
      "the live daemon's PID is still present and unchanged after spawning the isolated one",
      livePidsBefore.length === 0 || livePidsBefore.every((p) => livePidsDuring.includes(p)),
      `before=[${livePidsBefore.join(",")}], during=[${livePidsDuring.join(",")}]`,
    );

    console.log("--- launching Chromium with extension loaded ---");
    tmpProfileDir = await mkdtemp(path.join(tmpdir(), "metamux-e2e-profile-"));
    context = await chromium.launchPersistentContext(tmpProfileDir, {
      headless: false,
      executablePath: CHROMIUM_EXECUTABLE,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });

    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    }
    const extensionId = sw.url().split("/")[2];
    console.log("extension id:", extensionId);
    // Surface the SW's own console output and any uncaught exceptions --
    // MV3 service worker errors otherwise only show up in
    // chrome://extensions, never in this script's own stdout, which made
    // an earlier live regression report much harder to diagnose than it
    // needed to be.
    sw.on("console", (msg) => console.log(`[SW console:${msg.type()}]`, msg.text()));
    // "pageerror" isn't in playwright-core's typed Worker event union for a
    // ServiceWorker, but Chrome still emits it for uncaught exceptions --
    // cast rather than drop this debug aid.
    (sw as unknown as { on: (event: "pageerror", cb: (err: unknown) => void) => void }).on("pageerror", (err) =>
      console.log("[SW pageerror]", err),
    );

    async function getState(): Promise<any> {
      const res = await fetch(`http://127.0.0.1:${port}/state?token=${secret}`);
      if (!res.ok) throw new Error(`GET /state failed: ${res.status}`);
      return res.json();
    }

    // Resolve a wire identity's real tab group via the extension's own
    // mapping (byId is keyed by the WIRE identity -- the alias id in the
    // default groupBy: "title" -- never the raw registry id).
    async function activeGroupFor(identityId: string | null): Promise<chrome.tabGroups.TabGroup | null> {
      if (!identityId) return null;
      const stored = await sw.evaluate(() => chrome.storage.local.get("metamuxState"));
      const entry = stored.metamuxState?.byId?.[identityId];
      if (!entry || entry.groupId == null) return null;
      const groups = await sw.evaluate(
        (groupId) => chrome.tabGroups.query({}).then((gs) => gs.filter((g) => g.id === groupId)),
        entry.groupId,
      );
      return groups[0] ?? null;
    }

    console.log("--- configuring options page (pointed at the isolated port) ---");
    // Reuse an existing page (launchPersistentContext typically opens one
    // default blank page) rather than context.newPage() -- creating an
    // extra page has been observed to open in its OWN separate Chrome
    // window in this harness, which then confuses "the metamux window"
    // resolution downstream.
    const optionsPage = context.pages()[0] ?? (await context.newPage());
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await optionsPage.fill("#port", String(port));
    await optionsPage.fill("#secret", secret);
    await optionsPage.click("#test");
    await optionsPage.waitForTimeout(1000);
    const testResultText = await optionsPage.textContent("#test-result");
    record("options 'Test connection' reports ok", /ok/i.test(testResultText ?? ""), testResultText ?? "");
    await optionsPage.click("button[type=submit]");
    await optionsPage.waitForTimeout(300);
    // Close it: left open, Chrome/Playwright keeps re-focusing this tab
    // over the ones the extension itself activates via
    // tabs.update(tabId,{active:true}), which would otherwise make every
    // "is a tab in the group active" assertion below unreliable for
    // reasons that have nothing to do with the extension's own behavior.
    await optionsPage.close();

    console.log("--- waiting for extension to sync ---");
    await sleep(3000);

    // createGroups: "on-open" + a fresh isolated registry: NOTHING has
    // ever been attached yet, so the sync frame's workspaces list --
    // and therefore real Chrome tab groups -- must be empty.
    const groupsAtBoot: chrome.tabGroups.TabGroup[] = await sw.evaluate(() => chrome.tabGroups.query({}));
    record(
      "on-open + fresh registry: zero tab groups exist before anything is opened",
      groupsAtBoot.length === 0,
      `groups: [${groupsAtBoot.map((g) => g.title).join(", ")}]`,
    );

    const stateAtBoot = await getState();
    const openedIdentityTitle = stateAtBoot.workspaces.find((w: any) => w.id === stateAtBoot.activeId)?.title ?? null;
    record("an active workspace exists to exercise (real cmux state)", openedIdentityTitle !== null, JSON.stringify(stateAtBoot.activeId));

    console.log("--- cmux rpc workspace.next (activation alone must NOT create a group) ---");
    Bun.spawnSync(["cmux", "rpc", "workspace.next", "{}"], { cwd: REPO_ROOT });
    await sleep(1500);
    const groupsAfterActivationOnly: chrome.tabGroups.TabGroup[] = await sw.evaluate(() => chrome.tabGroups.query({}));
    record(
      "after workspace.next (no open), still zero tab groups",
      groupsAfterActivationOnly.length === 0,
      `groups: [${groupsAfterActivationOnly.map((g) => g.title).join(", ")}]`,
    );

    console.log("--- POST /open (this is what creates + attaches the group) ---");
    const openRes = await fetch(`http://127.0.0.1:${port}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: secret, url: "https://example.com/metamux-e2e" }),
    });
    const openBody = await openRes.json();
    record("POST /open reports ok", openRes.ok && openBody.ok === true, JSON.stringify(openBody));
    await sleep(1500);

    const openedIdentityId: string | null = openBody.workspace ?? null;
    const activeGroupAfterOpen = await activeGroupFor(openedIdentityId);
    record(
      "after POST /open, the target workspace's group now exists and is expanded",
      !!activeGroupAfterOpen && activeGroupAfterOpen.collapsed === false,
      `identity=${openedIdentityId}, group=${JSON.stringify(activeGroupAfterOpen)}`,
    );

    // Palette allocation (colorMode: "palette", the isolated config's
    // default -- not set explicitly above): a fresh isolated registry's
    // FIRST attachment claims palette index 0, whose chromeColor is
    // "blue" (palette.ts's ordering -- Blue is entry 1). Real cmux state
    // may have already colored this workspace by hand, which would
    // legitimately override the allocation (resolveColor's precedence) --
    // this assertion is conditional on that not being the case, same
    // "skipped, see above" pattern as the janitor/pruning assertions.
    if (activeGroupAfterOpen) {
      const rawAtOpen = stateAtBoot.workspaces.find((w: any) => w.id === stateAtBoot.activeId);
      if (rawAtOpen?.cmuxColor == null) {
        record(
          "fresh registry, no user color: the first-attached identity gets palette index 0 (blue)",
          activeGroupAfterOpen.color === "blue",
          `chrome tabGroups color=${activeGroupAfterOpen.color}`,
        );
      } else {
        record(
          "palette allocation assertion (skipped -- the opened workspace already has a real cmux color)",
          true,
          `cmuxColor=${rawAtOpen.cmuxColor}`,
        );
      }
    } else {
      record("palette allocation assertion (skipped -- no group was created to check)", false, "see POST /open assertions above");
    }

    let activeTabInGroup = false;
    let openedGroupTitle: string | null = null;
    if (activeGroupAfterOpen) {
      openedGroupTitle = activeGroupAfterOpen.title ?? null;
      const tabs = await sw.evaluate((groupId) => chrome.tabs.query({ groupId }), activeGroupAfterOpen.id);
      activeTabInGroup = tabs.some((t) => t.active);
    }
    record("after POST /open, a tab in the group is the active tab", activeTabInGroup);

    // --- Workspace-scoped browser automation: metamux_tab_context end to
    // end (POST /automation -> extension -> chrome.tabs.query, no
    // chrome.debugger involved -- cheap, ship-it-even-if-debugger-stalls
    // per the round's spec). ---
    if (openedIdentityId) {
      console.log("--- POST /automation (metamux_tab_context) ---");
      // No workspaceId: POST /open (above) targeted the daemon's own
      // active ref (no cmuxWorkspaceId was passed to it either), so the
      // daemon's activeId-fallback here resolves to the SAME target --
      // workspaceId would need a real mw_ id, not openedIdentityId (the
      // wire/alias id POST /open returned).
      const automationRes = await fetch(`http://127.0.0.1:${port}/automation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: secret, op: { kind: "tabContext" } }),
      });
      const automationBody = await automationRes.json();
      const tabs: Array<{ url?: string }> = Array.isArray(automationBody.result) ? automationBody.result : [];
      record(
        "metamux_tab_context returns the tab this script just opened, scoped to its own group",
        automationRes.ok && automationBody.ok === true && tabs.some((t) => t.url?.includes("metamux-e2e")),
        JSON.stringify(automationBody),
      );
    } else {
      record("metamux_tab_context assertion (skipped -- no group was created to check)", false, "see POST /open assertions above");
    }

    // --- Janitor: pre-create a duplicate-titled group, assert it merges. ---
    if (activeGroupAfterOpen && openedGroupTitle) {
      console.log("--- janitor: pre-creating a duplicate-titled blank group ---");
      const windowId = activeGroupAfterOpen.windowId;
      await sw.evaluate(
        async ({ windowId, title }) => {
          const tab = await chrome.tabs.create({ windowId, url: "chrome://newtab/", active: false });
          const groupId = await chrome.tabs.group({ tabIds: [tab.id as number] });
          await chrome.tabGroups.update(groupId, { title });
        },
        { windowId, title: openedGroupTitle },
      );

      const groupsBeforeMerge = await sw.evaluate(
        (title) => chrome.tabGroups.query({ title }).then((gs) => gs.length),
        openedGroupTitle,
      );
      record("duplicate group actually created (2 groups share the title now)", groupsBeforeMerge === 2, String(groupsBeforeMerge));

      console.log("--- triggering a fresh sync reconciliation (isolated config hot-reload) ---");
      // Safe here specifically because the config is isolated -- toggling
      // a real, shared config.json to force a sync was never an option in
      // earlier rounds. closeBehavior (not collapseOthers) is the toggle:
      // collapseOthers stays false for the whole run (see above).
      await writeFile(
        configPath,
        JSON.stringify({ createGroups: "on-open", groupBy: "title", janitor: true, collapseOthers: false, closeBehavior: "close" }),
      );
      await sleep(2000);

      const groupsAfterMerge = await sw.evaluate(
        (title) => chrome.tabGroups.query({ title }).then((gs) => gs.length),
        openedGroupTitle,
      );
      record(
        "janitor merges the duplicate away -- exactly one group with that title remains",
        groupsAfterMerge === 1,
        `count=${groupsAfterMerge}`,
      );
    } else {
      record("janitor merge assertion (skipped -- no group was created to duplicate)", false, "see POST /open assertions above");
    }

    // --- Sync-authoritative byId: close the group by hand (detach-on-close),
    // then a fresh sync should both clear the daemon's attachedAt AND prune
    // the extension's own byId entry for it. ---
    if (activeGroupAfterOpen && openedIdentityId && openedGroupTitle) {
      console.log("--- pruning: closing the group by hand, then a fresh sync should prune its byId entry ---");
      const beforeByIdCheck = await sw.evaluate(
        (id) => chrome.storage.local.get("metamuxState").then((s) => Boolean(s.metamuxState?.byId?.[id])),
        openedIdentityId,
      );
      record("byId has an entry for the opened identity before closing it", beforeByIdCheck);

      const groupIdToClose: number | null = await sw.evaluate(
        (title) => chrome.tabGroups.query({ title }).then((gs) => gs[0]?.id ?? null),
        openedGroupTitle,
      );
      if (groupIdToClose != null) {
        await sw.evaluate(async (groupId) => {
          const tabs = await chrome.tabs.query({ groupId });
          await chrome.tabs.remove(tabs.map((t) => t.id as number));
        }, groupIdToClose);
      }
      await sleep(1500);

      const stateAfterDetach = await getState();
      const detachedRaw = stateAfterDetach.workspaces.find((w: any) => w.title === openedGroupTitle);
      record(
        "daemon cleared attachedAt after the user-close (detach-on-close)",
        detachedRaw?.attachedAt === null,
        JSON.stringify(detachedRaw),
      );

      console.log("--- triggering one more sync (isolated config hot-reload) to prune byId ---");
      await writeFile(
        configPath,
        JSON.stringify({ createGroups: "on-open", groupBy: "title", janitor: true, collapseOthers: false, closeBehavior: "archive" }),
      );
      await sleep(2000);

      const afterByIdCheck = await sw.evaluate(
        (id) => chrome.storage.local.get("metamuxState").then((s) => Boolean(s.metamuxState?.byId?.[id])),
        openedIdentityId,
      );
      record("byId entry for the closed/detached identity is pruned after the next sync omits it", !afterByIdCheck);
    } else {
      record("pruning assertion (skipped -- no group was created to close)", false, "see POST /open assertions above");
    }

    console.log("--- cmux rpc workspace.previous (restoring real cmux focus) ---");
    Bun.spawnSync(["cmux", "rpc", "workspace.previous", "{}"], { cwd: REPO_ROOT });
    await sleep(500);
  } finally {
    console.log("\n--- cleanup ---");
    if (context) {
      await context.close().catch((err) => console.error("context close error", err));
    }
    if (tmpProfileDir) {
      await rm(tmpProfileDir, { recursive: true, force: true }).catch(() => {});
    }
    if (tmpStateDir) {
      await rm(tmpStateDir, { recursive: true, force: true }).catch(() => {});
    }
    if (tmpConfigDir) {
      await rm(tmpConfigDir, { recursive: true, force: true }).catch(() => {});
    }
    if (daemonProc) {
      daemonProc.kill();
      await daemonProc.exited.catch(() => {});
    }

    const livePidsAfter = await daemonPids();
    record(
      "zero contact with the live daemon: its PID set is unchanged after this script exits",
      JSON.stringify(livePidsAfter) === JSON.stringify(livePidsBefore),
      `before=[${livePidsBefore.join(",")}], after=[${livePidsAfter.join(",")}]`,
    );
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
