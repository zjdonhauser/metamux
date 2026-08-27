import { describe, expect, test } from "bun:test";
import { parseWindowFocusedLine } from "../src/parser.ts";

describe("parseWindowFocusedLine", () => {
  test("never throws on garbage input", () => {
    expect(() => parseWindowFocusedLine("")).not.toThrow();
    expect(() => parseWindowFocusedLine("not json")).not.toThrow();
    expect(() => parseWindowFocusedLine("{")).not.toThrow();
  });

  test("returns null for empty or malformed lines", () => {
    expect(parseWindowFocusedLine("")).toBeNull();
    expect(parseWindowFocusedLine("not json")).toBeNull();
  });

  test("returns null for non-window category", () => {
    const line = JSON.stringify({
      category: "workspace",
      name: "window.focused",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { window_id: "W1", workspace_id: "WS1" },
    });
    expect(parseWindowFocusedLine(line)).toBeNull();
  });

  test("returns null for window-category events other than window.focused", () => {
    for (const name of ["window.keyed", "window.unkeyed", "window.created", "window.closed"]) {
      const line = JSON.stringify({
        category: "window",
        name,
        boot_id: "B1",
        seq: 1,
        occurred_at: "2026-08-26T00:00:00.000Z",
        payload: { window_id: "W1", workspace_id: "WS1" },
      });
      expect(parseWindowFocusedLine(line)).toBeNull();
    }
  });

  test("parses a real window.focused line", () => {
    // real line from ~/.cmuxterm/events.jsonl.1 (seq 3124)
    const line = JSON.stringify({
      boot_id: "C76575AA-3591-45C5-8F6C-A3D4679CF1B8",
      category: "window",
      name: "window.focused",
      occurred_at: "2026-08-26T20:24:01.470Z",
      payload: {
        is_key_window: true,
        is_main_window: true,
        origin: "focus_request",
        selected_workspace_index: 3,
        window_id: "91FBCD4C-89EF-4F20-B79F-CC00B5017D8B",
        workspace_count: 7,
        workspace_id: "60A7BAD8-B32E-4E55-8077-71AFD5BE1615",
      },
      seq: 3124,
      window_id: "91FBCD4C-89EF-4F20-B79F-CC00B5017D8B",
      workspace_id: "60A7BAD8-B32E-4E55-8077-71AFD5BE1615",
    });
    const event = parseWindowFocusedLine(line);
    expect(event).not.toBeNull();
    expect(event?.windowId).toBe("91FBCD4C-89EF-4F20-B79F-CC00B5017D8B");
    expect(event?.workspaceId).toBe("60A7BAD8-B32E-4E55-8077-71AFD5BE1615");
    expect(event?.bootId).toBe("C76575AA-3591-45C5-8F6C-A3D4679CF1B8");
    expect(event?.seq).toBe(3124);
  });

  test("returns null when workspace_id cannot be resolved", () => {
    const line = JSON.stringify({
      category: "window",
      name: "window.focused",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { window_id: "W1" },
    });
    expect(parseWindowFocusedLine(line)).toBeNull();
  });

  test("returns null when window_id cannot be resolved", () => {
    const line = JSON.stringify({
      category: "window",
      name: "window.focused",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { workspace_id: "WS1" },
    });
    expect(parseWindowFocusedLine(line)).toBeNull();
  });
});
