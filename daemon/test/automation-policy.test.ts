import { describe, expect, test } from "bun:test";
import { toolAllowed } from "../src/automation-policy.ts";

describe("toolAllowed", () => {
  test("agentBrowser: off refuses every op", () => {
    for (const op of ["tabContext", "snapshot", "screenshot", "navigate", "click", "type"]) {
      expect(toolAllowed(op, "off")).toBe(false);
    }
  });

  test("agentBrowser: read allows the read-only ops", () => {
    expect(toolAllowed("tabContext", "read")).toBe(true);
    expect(toolAllowed("snapshot", "read")).toBe(true);
    expect(toolAllowed("screenshot", "read")).toBe(true);
  });

  test("agentBrowser: read refuses the write ops", () => {
    expect(toolAllowed("navigate", "read")).toBe(false);
    expect(toolAllowed("click", "read")).toBe(false);
    expect(toolAllowed("type", "read")).toBe(false);
  });

  test("agentBrowser: full allows everything", () => {
    for (const op of ["tabContext", "snapshot", "screenshot", "navigate", "click", "type"]) {
      expect(toolAllowed(op, "full")).toBe(true);
    }
  });

  test("an unknown op kind is refused regardless of mode", () => {
    expect(toolAllowed("bogus", "full")).toBe(false);
  });
});
