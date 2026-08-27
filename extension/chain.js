// @ts-check
// Sequential async chain with per-step failure isolation. No chrome.*
// dependency -- pure Promise composition, kept in its own module so it's
// unit-testable without mocking the extension APIs sw.js needs for
// everything else it does.

/**
 * Appends `task` to `prevChain`, waiting for the previous step to settle
 * (regardless of whether it failed) before running this one, and catching
 * this step's own rejection via `onError` so it never propagates to the
 * NEXT `chainStep` call.
 *
 * Without this: `(prevChain ?? Promise.resolve()).then(task)` looks
 * sequential but isn't failure-isolated -- once one `task` throws,
 * `prevChain` becomes a permanently rejected promise, and every later
 * `.then(task)` on an already-rejected promise skips `task` entirely and
 * just re-rejects with the same reason. `task` is never called again for
 * the rest of the chain's lifetime (sw.js's `dispatchChain` is exactly
 * this pattern -- one bad message used to silently freeze extension state
 * forever).
 *
 * @template T
 * @param {Promise<any>|null} prevChain
 * @param {() => Promise<T>} task
 * @param {(err: unknown) => void} onError
 * @returns {Promise<T|undefined>} always resolves, never rejects
 */
export function chainStep(prevChain, task, onError) {
  const settledPrev = (prevChain ?? Promise.resolve()).catch(() => {});
  return settledPrev.then(task).catch((err) => {
    onError(err);
    return undefined;
  });
}
