import { describe, expect, test } from "bun:test";
import { PendingRequestTable } from "../src/automation-rpc.ts";

/** A fake scheduler that never fires on its own -- tests call the captured
 * callback directly to simulate a timeout deterministically, no real
 * sleeping. */
function fakeScheduler() {
  const scheduled: { cb: () => void; ms: number; cancelled: boolean }[] = [];
  const scheduler = (cb: () => void, ms: number) => {
    const entry = { cb, ms, cancelled: false };
    scheduled.push(entry);
    return { cancel: () => (entry.cancelled = true) };
  };
  const fireAll = () => {
    for (const entry of scheduled) if (!entry.cancelled) entry.cb();
  };
  return { scheduler, scheduled, fireAll };
}

describe("PendingRequestTable", () => {
  test("resolveRequest resolves the promise register() returned", async () => {
    const { scheduler } = fakeScheduler();
    const table = new PendingRequestTable(scheduler);
    const promise = table.register("req-1", 15000);
    expect(table.resolveRequest("req-1", { ok: true })).toBe(true);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  test("rejectRequest rejects the promise register() returned", async () => {
    const { scheduler } = fakeScheduler();
    const table = new PendingRequestTable(scheduler);
    const promise = table.register("req-1", 15000);
    expect(table.rejectRequest("req-1", new Error("boom"))).toBe(true);
    await expect(promise).rejects.toThrow("boom");
  });

  test("resolveRequest for an unknown id is a no-op, returns false", () => {
    const { scheduler } = fakeScheduler();
    const table = new PendingRequestTable(scheduler);
    expect(table.resolveRequest("unknown", {})).toBe(false);
  });

  test("a second resolveRequest for the same id is a no-op (already settled)", async () => {
    const { scheduler } = fakeScheduler();
    const table = new PendingRequestTable(scheduler);
    const promise = table.register("req-1", 15000);
    table.resolveRequest("req-1", "first");
    expect(table.resolveRequest("req-1", "second")).toBe(false);
    await expect(promise).resolves.toBe("first");
  });

  test("the scheduled timeout rejects the promise when it fires", async () => {
    const { scheduler, fireAll } = fakeScheduler();
    const table = new PendingRequestTable(scheduler);
    const promise = table.register("req-1", 15000);
    fireAll();
    await expect(promise).rejects.toThrow(/timed out/);
  });

  test("resolving before the timeout cancels the scheduled timer", () => {
    const { scheduler, scheduled } = fakeScheduler();
    const table = new PendingRequestTable(scheduler);
    table.register("req-1", 15000);
    table.resolveRequest("req-1", "done");
    expect(scheduled[0]!.cancelled).toBe(true);
  });

  test("size() reflects the number of in-flight requests", () => {
    const { scheduler } = fakeScheduler();
    const table = new PendingRequestTable(scheduler);
    expect(table.size()).toBe(0);
    table.register("req-1", 15000);
    table.register("req-2", 15000);
    expect(table.size()).toBe(2);
    table.resolveRequest("req-1", null);
    expect(table.size()).toBe(1);
  });

  test("timing out removes the entry (size() drops)", () => {
    const { scheduler, fireAll } = fakeScheduler();
    const table = new PendingRequestTable(scheduler);
    table.register("req-1", 15000).catch(() => {}); // swallow the rejection for this assertion
    expect(table.size()).toBe(1);
    fireAll();
    expect(table.size()).toBe(0);
  });
});
