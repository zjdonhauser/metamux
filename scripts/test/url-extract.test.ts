import { describe, expect, test } from "bun:test";
import { dedupeAgainstRecent, extractGithubUrls, pruneExpired, RECENT_URL_TTL_MS } from "../url-extract.ts";

describe("extractGithubUrls", () => {
  test("matches a PR view/create URL", () => {
    const text = "https://github.com/safelease/metamux/pull/42\ndone.";
    expect(extractGithubUrls(text)).toEqual(["https://github.com/safelease/metamux/pull/42"]);
  });

  test("matches a compare URL", () => {
    const text = "open https://github.com/safelease/metamux/compare/main...feature-branch here";
    expect(extractGithubUrls(text)).toEqual([
      "https://github.com/safelease/metamux/compare/main...feature-branch",
    ]);
  });

  test("canonicalizes PR sub-pages and dedupes them together", () => {
    const text = [
      "https://github.com/safelease/metamux/pull/7/files",
      "https://github.com/safelease/metamux/pull/7/commits",
      "https://github.com/safelease/metamux/pull/7",
    ].join("\n");
    expect(extractGithubUrls(text)).toEqual(["https://github.com/safelease/metamux/pull/7"]);
  });

  test("trims trailing punctuation picked up from surrounding prose", () => {
    const text = "See (https://github.com/safelease/metamux/compare/main...fix-x).";
    expect(extractGithubUrls(text)).toEqual([
      "https://github.com/safelease/metamux/compare/main...fix-x",
    ]);
  });

  test("returns nothing for text with no matching URLs", () => {
    expect(extractGithubUrls("just some Bash output, no links here")).toEqual([]);
  });
});

describe("pruneExpired", () => {
  test("drops entries older than the TTL", () => {
    const now = 1_000_000;
    const recent = {
      "https://github.com/a/b/pull/1": now - RECENT_URL_TTL_MS - 1,
      "https://github.com/a/b/pull/2": now - 1000,
    };
    expect(pruneExpired(recent, now)).toEqual({
      "https://github.com/a/b/pull/2": now - 1000,
    });
  });
});

describe("dedupeAgainstRecent", () => {
  test("keeps a URL not seen before as fresh", () => {
    const now = 1_000_000;
    const { fresh, updated } = dedupeAgainstRecent(["https://github.com/a/b/pull/1"], {}, now);
    expect(fresh).toEqual(["https://github.com/a/b/pull/1"]);
    expect(updated["https://github.com/a/b/pull/1"]).toBe(now);
  });

  test("suppresses a URL seen within the TTL window", () => {
    const now = 1_000_000;
    const recent = { "https://github.com/a/b/pull/1": now - 1000 };
    const { fresh } = dedupeAgainstRecent(["https://github.com/a/b/pull/1"], recent, now);
    expect(fresh).toEqual([]);
  });

  test("re-admits a URL once its TTL has expired, and refreshes it", () => {
    const now = 1_000_000;
    const recent = { "https://github.com/a/b/pull/1": now - RECENT_URL_TTL_MS - 1 };
    const { fresh, updated } = dedupeAgainstRecent(["https://github.com/a/b/pull/1"], recent, now);
    expect(fresh).toEqual(["https://github.com/a/b/pull/1"]);
    expect(updated["https://github.com/a/b/pull/1"]).toBe(now);
  });
});
