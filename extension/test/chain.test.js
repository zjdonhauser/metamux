import { describe, test, expect } from "bun:test";
import { chainStep } from "../chain.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("chainStep", () => {
  test("regression: a rejecting task does not stop later chainStep calls from running (sw.js dispatchChain, 2026-08-27)", async () => {
    // Before the fix, `(prevChain ?? Promise.resolve()).then(task)` looked
    // sequential but wasn't failure-isolated: once `task` threw, prevChain
    // became a permanently rejected promise, and every later
    // `.then(task)` on it skipped `task` entirely -- it was never called
    // again for the rest of the chain's lifetime. This is the exact shape
    // sw.js's `dispatchChain` uses to serialize WS message dispatch.
    const ran = [];
    const errors = [];
    let chain = null;

    chain = chainStep(chain, () => Promise.resolve().then(() => ran.push("a")), (err) => errors.push(err));
    chain = chainStep(
      chain,
      () => Promise.reject(new Error("boom")),
      (err) => errors.push(err),
    );
    chain = chainStep(chain, () => Promise.resolve().then(() => ran.push("c")), (err) => errors.push(err));

    await chain;

    expect(ran).toEqual(["a", "c"]); // "c" still ran despite "b"'s rejection
    expect(errors).toHaveLength(1);
    expect(/** @type {Error} */ (errors[0]).message).toBe("boom");
  });

  test("preserves ordering: each task waits for the previous one to settle first", async () => {
    const order = [];
    let chain = null;

    chain = chainStep(
      chain,
      async () => {
        await sleep(20);
        order.push(1);
      },
      () => {},
    );
    chain = chainStep(
      chain,
      async () => {
        order.push(2);
      },
      () => {},
    );

    await chain;
    expect(order).toEqual([1, 2]); // task 2 didn't run before task 1's slower work finished
  });

  test("a chain with no rejections at all runs every task exactly once, in order", async () => {
    const ran = [];
    let chain = null;
    for (const label of ["a", "b", "c"]) {
      chain = chainStep(chain, () => Promise.resolve().then(() => ran.push(label)), () => {});
    }
    await chain;
    expect(ran).toEqual(["a", "b", "c"]);
  });

  test("multiple consecutive rejections are each isolated -- the chain survives all of them", async () => {
    const ran = [];
    const errors = [];
    let chain = null;

    chain = chainStep(chain, () => Promise.reject(new Error("first")), (err) => errors.push(err));
    chain = chainStep(chain, () => Promise.reject(new Error("second")), (err) => errors.push(err));
    chain = chainStep(chain, () => Promise.resolve().then(() => ran.push("survivor")), (err) => errors.push(err));

    await chain;

    expect(ran).toEqual(["survivor"]);
    expect(errors.map((e) => /** @type {Error} */ (e).message)).toEqual(["first", "second"]);
  });

  test("the returned promise itself never rejects, even when the task does", async () => {
    let rejected = false;
    await chainStep(null, () => Promise.reject(new Error("x")), () => {}).catch(() => {
      rejected = true;
    });
    expect(rejected).toBe(false); // chainStep's own catch already absorbed it
  });
});
