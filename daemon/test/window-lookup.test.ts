import { describe, expect, test } from "bun:test";
import { WindowLookup } from "../src/window-lookup.ts";

describe("WindowLookup", () => {
  test("looks up a workspace's holding window", async () => {
    const l = new WindowLookup(async () => "WIN-A");
    expect(await l.holdingWindow("ws1", 0)).toBe("WIN-A");
  });

  // listWindows + listTabs per window is N+1 CLI calls, and selections are
  // frequent. A repeat inside the window returns the cached answer.
  test("throttles repeat lookups for the same workspace", async () => {
    let calls = 0;
    const l = new WindowLookup(async () => { calls++; return "WIN-A"; }, { minIntervalMs: 5_000 });

    expect(await l.holdingWindow("ws1", 0)).toBe("WIN-A");
    expect(await l.holdingWindow("ws1", 1_000)).toBe("WIN-A");
    expect(calls).toBe(1);

    expect(await l.holdingWindow("ws1", 6_000)).toBe("WIN-A");
    expect(calls).toBe(2);
  });

  test("throttles per workspace, not globally", async () => {
    let calls = 0;
    const l = new WindowLookup(async () => { calls++; return "WIN-A"; }, { minIntervalMs: 5_000 });
    await l.holdingWindow("ws1", 0);
    await l.holdingWindow("ws2", 100);
    expect(calls).toBe(2);
  });

  test("a failed lookup returns null and is not cached as an answer", async () => {
    let calls = 0;
    const l = new WindowLookup(async () => { calls++; throw new Error("cmux down"); }, { minIntervalMs: 5_000 });
    expect(await l.holdingWindow("ws1", 0)).toBeNull();
    // Retried rather than serving a cached failure.
    expect(await l.holdingWindow("ws1", 1_000)).toBeNull();
    expect(calls).toBe(2);
  });

  test("a null result is cached, since 'not in any window' is a real answer", async () => {
    let calls = 0;
    const l = new WindowLookup(async () => { calls++; return null; }, { minIntervalMs: 5_000 });
    expect(await l.holdingWindow("ws1", 0)).toBeNull();
    expect(await l.holdingWindow("ws1", 1_000)).toBeNull();
    expect(calls).toBe(1);
  });

  test("coalesces concurrent lookups for the same workspace", async () => {
    let calls = 0;
    const l = new WindowLookup(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return "WIN-A";
    });
    const [a, b] = await Promise.all([l.holdingWindow("ws1", 0), l.holdingWindow("ws1", 0)]);
    expect(a).toBe("WIN-A");
    expect(b).toBe("WIN-A");
    expect(calls).toBe(1);
  });
});
