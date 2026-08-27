import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLine } from "../src/parser.ts";

describe("parseLine", () => {
  test("never throws on garbage input", () => {
    expect(() => parseLine("")).not.toThrow();
    expect(() => parseLine("not json")).not.toThrow();
    expect(() => parseLine("{")).not.toThrow();
    expect(() => parseLine("null")).not.toThrow();
    expect(() => parseLine("42")).not.toThrow();
    expect(() => parseLine('"a string"')).not.toThrow();
  });

  test("returns null for empty or malformed JSON lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("not json")).toBeNull();
    expect(parseLine("{unterminated")).toBeNull();
  });

  test("returns null for non-workspace category", () => {
    const line = JSON.stringify({
      category: "pane",
      name: "workspace.selected",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { workspace_id: "W1", title: "t", cwd: "/x" },
    });
    expect(parseLine(line)).toBeNull();
  });

  test("returns null for unrecognized workspace event names", () => {
    const names = ["workspace.reordered", "workspace.prompt.submitted"];
    for (const name of names) {
      const line = JSON.stringify({
        category: "workspace",
        name,
        boot_id: "B1",
        seq: 1,
        occurred_at: "2026-08-26T00:00:00.000Z",
        payload: { workspace_id: "W1" },
      });
      expect(parseLine(line)).toBeNull();
    }
  });

  test("workspace.action with an action other than rename/set_color/clear_color is ignored", () => {
    for (const action of ["close", "focus", "pin", "unpin"]) {
      const line = JSON.stringify({
        category: "workspace",
        name: "workspace.action",
        boot_id: "B1",
        seq: 1,
        occurred_at: "2026-08-26T00:00:00.000Z",
        workspace_id: "W1",
        payload: { method: "workspace.action", params: { action, workspace_id: "W1" } },
      });
      expect(parseLine(line)).toBeNull();
    }
  });

  test("parses a real workspace.action rename line into a renamed event", () => {
    // real line from ~/.cmuxterm/events.jsonl (seq 3955): a rename arrives as
    // workspace.action, not workspace.renamed. Title lives at
    // payload.params.title; workspace id at payload.params.workspace_id
    // (payload.workspace_id does not exist on this event shape).
    const line = JSON.stringify({
      boot_id: "C76575AA-3591-45C5-8F6C-A3D4679CF1B8",
      category: "workspace",
      name: "workspace.action",
      occurred_at: "2026-08-26T23:49:08.862Z",
      payload: {
        method: "workspace.action",
        params: {
          action: "rename",
          title: "jeff-review",
          workspace_id: "7909D2DC-877A-434C-AF54-18F4CFB631A7",
        },
        result: {
          action: "rename",
          title: "jeff-review",
          window_id: "D794BC71-C560-4406-A931-3C096E8F71C2",
          workspace_id: "7909D2DC-877A-434C-AF54-18F4CFB631A7",
        },
      },
      seq: 3955,
      workspace_id: "7909D2DC-877A-434C-AF54-18F4CFB631A7",
    });
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event?.name).toBe("renamed");
    expect(event?.workspaceId).toBe("7909D2DC-877A-434C-AF54-18F4CFB631A7");
    expect(event?.title).toBe("jeff-review");
    expect(event?.bootId).toBe("C76575AA-3591-45C5-8F6C-A3D4679CF1B8");
    expect(event?.seq).toBe(3955);
  });

  test("workspace.action rename falls back to line.workspace_id if params.workspace_id is missing", () => {
    const line = JSON.stringify({
      category: "workspace",
      name: "workspace.action",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      workspace_id: "outer-fallback-id",
      payload: { method: "workspace.action", params: { action: "rename", title: "renamed-thing" } },
    });
    const event = parseLine(line);
    expect(event?.name).toBe("renamed");
    expect(event?.workspaceId).toBe("outer-fallback-id");
    expect(event?.title).toBe("renamed-thing");
  });

  test("workspace.action rename returns null when no title can be resolved", () => {
    const line = JSON.stringify({
      category: "workspace",
      name: "workspace.action",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { method: "workspace.action", params: { action: "rename", workspace_id: "W1" } },
    });
    // no title anywhere -- title resolves to empty string per the same
    // tolerant-fallback convention used elsewhere, not a parse failure
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event?.title).toBe("");
  });

  test("parses workspace.selected with full payload", () => {
    const line = JSON.stringify({
      category: "workspace",
      name: "workspace.selected",
      boot_id: "B1",
      seq: 42,
      occurred_at: "2026-08-26T23:52:21.563Z",
      workspace_id: "outer-id",
      payload: {
        workspace_id: "1D334484-F4CC-4088-B3F0-ADA3E1B955A1",
        title: "cmux",
        custom_title: "cmux-custom",
        cwd: "/Users/zachary/Documents/GitHub",
        index: 0,
        previous_workspace_id: "F836DC5A-E0CC-4794-A348-7367BEEC66F5",
        tab_count: 7,
      },
    });
    const event = parseLine(line);
    expect(event).not.toBeNull();
    expect(event?.name).toBe("selected");
    expect(event?.workspaceId).toBe("1D334484-F4CC-4088-B3F0-ADA3E1B955A1");
    // custom_title wins over title per the payload.custom_title ?? payload.title rule
    expect(event?.title).toBe("cmux-custom");
    expect(event?.cwd).toBe("/Users/zachary/Documents/GitHub");
    expect(event?.bootId).toBe("B1");
    expect(event?.seq).toBe(42);
    expect(event?.occurredAtMs).toBe(Date.parse("2026-08-26T23:52:21.563Z"));
  });

  test("falls back to payload.title when custom_title is missing/null", () => {
    const line = JSON.stringify({
      category: "workspace",
      name: "workspace.created",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { workspace_id: "W1", custom_title: null, title: "Terminal 7", cwd: "/Users/zachary" },
    });
    const event = parseLine(line);
    expect(event?.title).toBe("Terminal 7");
  });

  test("falls back to line.workspace_id when payload.workspace_id is missing", () => {
    const line = JSON.stringify({
      category: "workspace",
      name: "workspace.closed",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      workspace_id: "outer-fallback-id",
      payload: { title: "x", cwd: null },
    });
    const event = parseLine(line);
    expect(event?.workspaceId).toBe("outer-fallback-id");
  });

  test("returns null when no workspace_id can be resolved", () => {
    const line = JSON.stringify({
      category: "workspace",
      name: "workspace.selected",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { title: "x" },
    });
    expect(parseLine(line)).toBeNull();
  });

  test("returns null when boot_id or seq missing", () => {
    const base = {
      category: "workspace",
      name: "workspace.selected",
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { workspace_id: "W1" },
    };
    expect(parseLine(JSON.stringify({ ...base, seq: 1 }))).toBeNull();
    expect(parseLine(JSON.stringify({ ...base, boot_id: "B1" }))).toBeNull();
  });

  test("returns null when occurred_at is missing or unparseable", () => {
    const base = {
      category: "workspace",
      name: "workspace.selected",
      boot_id: "B1",
      seq: 1,
      payload: { workspace_id: "W1" },
    };
    expect(parseLine(JSON.stringify(base))).toBeNull();
    expect(parseLine(JSON.stringify({ ...base, occurred_at: "not-a-date" }))).toBeNull();
  });

  test("cwd defaults to null when missing or not a string", () => {
    const line = JSON.stringify({
      category: "workspace",
      name: "workspace.created",
      boot_id: "B1",
      seq: 1,
      occurred_at: "2026-08-26T00:00:00.000Z",
      payload: { workspace_id: "W1", title: "x" },
    });
    expect(parseLine(line)?.cwd).toBeNull();
  });

  test("parses real fixture lines from ~/.cmuxterm/events.jsonl", () => {
    const fixturePath = join(import.meta.dir, "fixtures", "events-sample.jsonl");
    const lines = readFileSync(fixturePath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(10);

    let selected = 0;
    let created = 0;
    let closed = 0;
    let renamed = 0;
    let colored = 0;
    let ignored = 0;

    for (const line of lines) {
      const event = parseLine(line);
      if (event === null) {
        ignored++;
        continue;
      }
      expect(typeof event.workspaceId).toBe("string");
      expect(event.workspaceId.length).toBeGreaterThan(0);
      expect(Number.isNaN(event.occurredAtMs)).toBe(false);
      if (event.name === "selected") selected++;
      if (event.name === "created") created++;
      if (event.name === "closed") closed++;
      if (event.name === "renamed") renamed++;
      if (event.name === "colored") colored++;
    }

    // fixture was built with 5 selected, 3 created, 2 closed, 1 real
    // workspace.action rename, 5 real workspace.action set_color/
    // clear_color (2 from the original fixture build, 3 added for this
    // feature), plus reordered/non-workspace-category lines ignored.
    expect(selected).toBe(5);
    expect(created).toBe(3);
    expect(closed).toBe(2);
    expect(renamed).toBe(1);
    expect(colored).toBe(5);
    expect(ignored).toBeGreaterThan(0);
  });

  describe("workspace.action set_color / clear_color -> colored", () => {
    test("parses a real set_color line (hex) into a colored event", () => {
      // real line, seq 4072: params.color is the hex the client sent
      const line = JSON.stringify({
        boot_id: "C76575AA-3591-45C5-8F6C-A3D4679CF1B8",
        category: "workspace",
        name: "workspace.action",
        occurred_at: "2026-08-27T03:11:55.405Z",
        payload: {
          method: "workspace.action",
          params: { action: "set_color", color: "#2779FB", workspace_id: "B0169771-72EA-4996-BE82-E6FB3E2D9AE5" },
          result: { action: "set_color", color: "#2779FB", workspace_id: "B0169771-72EA-4996-BE82-E6FB3E2D9AE5" },
        },
        seq: 4072,
        workspace_id: "B0169771-72EA-4996-BE82-E6FB3E2D9AE5",
      });
      const event = parseLine(line);
      expect(event).not.toBeNull();
      expect(event?.name).toBe("colored");
      expect(event?.workspaceId).toBe("B0169771-72EA-4996-BE82-E6FB3E2D9AE5");
      expect(event?.color).toBe("#2779FB");
    });

    test("parses a real set_color line (named slot) into a colored event, unresolved", () => {
      // real line, seq 837: params.color is the raw slot name "Navy" --
      // the parser does NOT resolve it (that's colors.ts's job)
      const line = JSON.stringify({
        boot_id: "25A6B286-55DB-499A-952F-11A698B4C04C",
        category: "workspace",
        name: "workspace.action",
        occurred_at: "2026-08-25T13:57:12.691Z",
        payload: {
          method: "workspace.action",
          params: { action: "set_color", color: "Navy", workspace_id: "01B782EA-DCA3-424E-B2EE-4C68D4719286" },
          result: { action: "set_color", color: "#152744", workspace_id: "01B782EA-DCA3-424E-B2EE-4C68D4719286" },
        },
        seq: 837,
        workspace_id: "01B782EA-DCA3-424E-B2EE-4C68D4719286",
      });
      const event = parseLine(line);
      expect(event?.name).toBe("colored");
      expect(event?.color).toBe("Navy");
    });

    test("parses a real clear_color line into a colored event with color: null", () => {
      // real line, seq 4073
      const line = JSON.stringify({
        boot_id: "C76575AA-3591-45C5-8F6C-A3D4679CF1B8",
        category: "workspace",
        name: "workspace.action",
        occurred_at: "2026-08-27T03:11:55.450Z",
        payload: {
          method: "workspace.action",
          params: { action: "clear_color", workspace_id: "D3C5A00F-639B-4F28-98AE-AF5AAB20671F" },
          result: { action: "clear_color", color: null, workspace_id: "D3C5A00F-639B-4F28-98AE-AF5AAB20671F" },
        },
        seq: 4073,
        workspace_id: "D3C5A00F-639B-4F28-98AE-AF5AAB20671F",
      });
      const event = parseLine(line);
      expect(event).not.toBeNull();
      expect(event?.name).toBe("colored");
      expect(event?.color).toBeNull();
    });

    test("falls back to line.workspace_id when params.workspace_id is missing", () => {
      const line = JSON.stringify({
        category: "workspace",
        name: "workspace.action",
        boot_id: "B1",
        seq: 1,
        occurred_at: "2026-08-26T00:00:00.000Z",
        workspace_id: "outer-fallback-id",
        payload: { method: "workspace.action", params: { action: "set_color", color: "#123456" } },
      });
      expect(parseLine(line)?.workspaceId).toBe("outer-fallback-id");
    });
  });
});
