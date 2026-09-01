import { describe, expect, test } from "bun:test";
import { OpenRateLimiter } from "../src/open-rate-limit.ts";

describe("OpenRateLimiter", () => {
  test("allows opens up to the cap", () => {
    const limiter = new OpenRateLimiter(3, 10_000);
    expect(limiter.check("w1", 0).allowed).toBe(true);
    expect(limiter.check("w1", 1).allowed).toBe(true);
    expect(limiter.check("w1", 2).allowed).toBe(true);
  });

  // The exact failure this exists to stop: 51 calls in under a second.
  test("rejects the burst that started this", () => {
    const limiter = new OpenRateLimiter(8, 10_000);
    let rejected = 0;
    for (let i = 0; i < 51; i++) {
      if (!limiter.check("1897", i).allowed) rejected++;
    }
    expect(rejected).toBe(51 - 8);
  });

  test("reports how many landed in the window on rejection", () => {
    const limiter = new OpenRateLimiter(2, 10_000);
    limiter.check("w1", 0);
    limiter.check("w1", 1);
    expect(limiter.check("w1", 2)).toEqual({ allowed: false, countInWindow: 2 });
  });

  // Sliding, not a fixed bucket: an old timestamp ages out and frees a slot,
  // rather than the caller being stuck until some fixed boundary passes.
  test("an old timestamp aging out of the window frees a slot", () => {
    const limiter = new OpenRateLimiter(2, 10_000);
    limiter.check("w1", 0);
    limiter.check("w1", 1);
    expect(limiter.check("w1", 5_000).allowed).toBe(false);
    expect(limiter.check("w1", 10_001).allowed).toBe(true);
  });

  test("workspaces are isolated from each other", () => {
    const limiter = new OpenRateLimiter(1, 10_000);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 0).allowed).toBe(true);
    expect(limiter.check("a", 1).allowed).toBe(false);
  });

  // A rejected attempt must not itself extend the window: a caller retrying
  // past the cap should be able to succeed the moment the window clears,
  // not be punished further for having tried.
  test("a rejected attempt is not recorded", () => {
    const limiter = new OpenRateLimiter(1, 10_000);
    limiter.check("w1", 0);
    limiter.check("w1", 1);
    limiter.check("w1", 2);
    expect(limiter.check("w1", 10_001).allowed).toBe(true);
  });

  test("a fresh workspace has never been seen and is allowed", () => {
    const limiter = new OpenRateLimiter(1, 10_000);
    expect(limiter.check("never-seen", 999_999).allowed).toBe(true);
  });
});
