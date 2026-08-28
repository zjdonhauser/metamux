import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHttpToolHandlers } from "../src/mcp-server.ts";

// metamux_open must pick the same target the CLI picks (cli/metamux.ts:68):
// the calling shell's workspace, not whichever tab happens to be visually
// active. Getting this wrong drops an agent's link into someone else's group,
// which is exactly what happened on 2026-08-28.

const STATE = {
  activeId: "mw_active",
  workspaces: [
    { id: "mw_caller", title: "mh-accounts", cwd: "/w/caller", sourceId: "SRC-CALLER", archived: false },
    { id: "mw_active", title: "compliance", cwd: "/w/active", sourceId: "SRC-ACTIVE", archived: false },
  ],
};

let openBodies: Record<string, unknown>[];
let savedEnv: string | undefined;

function handlers() {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.includes("/open")) {
      openBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify(STATE), { status: 200 });
  }) as unknown as typeof fetch;

  return createHttpToolHandlers({ port: 1, token: "t", fetchImpl });
}

beforeEach(() => {
  openBodies = [];
  savedEnv = process.env.CMUX_WORKSPACE_ID;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CMUX_WORKSPACE_ID;
  else process.env.CMUX_WORKSPACE_ID = savedEnv;
});

describe("metamux_open target resolution", () => {
  test("defaults to the calling shell's workspace, not the active one", async () => {
    process.env.CMUX_WORKSPACE_ID = "SRC-CALLER";
    await handlers().metamux_open({ url: "https://example.test" });

    expect(openBodies).toHaveLength(1);
    expect(openBodies[0].cmuxWorkspaceId).toBe("SRC-CALLER");
  });

  test("an explicit workspaceId still wins over the calling shell", async () => {
    process.env.CMUX_WORKSPACE_ID = "SRC-CALLER";
    await handlers().metamux_open({ url: "https://example.test", workspaceId: "mw_active" });

    expect(openBodies[0].cmuxWorkspaceId).toBe("SRC-ACTIVE");
  });

  test("active: true targets the daemon's active workspace", async () => {
    process.env.CMUX_WORKSPACE_ID = "SRC-CALLER";
    await handlers().metamux_open({ url: "https://example.test", active: true });

    // Omitting cmuxWorkspaceId is how POST /open is told to use its own activeId.
    expect(openBodies[0].cmuxWorkspaceId).toBeUndefined();
  });

  test("falls back to the active workspace when the harness dropped the env var", async () => {
    delete process.env.CMUX_WORKSPACE_ID;
    await handlers().metamux_open({ url: "https://example.test" });

    expect(openBodies[0].cmuxWorkspaceId).toBeUndefined();
  });

  test("rejects an unknown explicit workspaceId instead of silently using active", async () => {
    process.env.CMUX_WORKSPACE_ID = "SRC-CALLER";
    await expect(
      handlers().metamux_open({ url: "https://example.test", workspaceId: "mw_nope" }),
    ).rejects.toThrow("unknown workspaceId: mw_nope");
    expect(openBodies).toHaveLength(0);
  });
});
