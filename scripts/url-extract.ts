// Pure URL extraction + dedup logic for the Claude Code PostToolUse hook.
// No I/O here -- see scripts/claude-url-hook.ts for the fs/network glue.

const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[^\s"'<>)\]]*)?/g;
const COMPARE_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/compare\/[^\s"'<>)\]]+/g;

/** Strip trailing punctuation a greedy URL match commonly over-captures (. , ) ] etc). */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/, "");
}

/** Canonical PR URL: org/repo/pull/n, dropping any /files, /commits, query, or fragment suffix. */
function canonicalPrUrl(org: string, repo: string, n: string): string {
  return `https://github.com/${org}/${repo}/pull/${n}`;
}

/**
 * Extract high-signal GitHub URLs (PR view/create, branch compare) from free
 * text. Returns unique URLs in first-seen order. PR URLs are canonicalized
 * to strip suffixes like `/files` so the same PR dedupes regardless of which
 * sub-page a command happened to print.
 */
export function extractGithubUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const match of text.matchAll(PR_URL_RE)) {
    const [, org, repo, n] = match;
    const url = canonicalPrUrl(org, repo, n);
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }

  for (const match of text.matchAll(COMPARE_URL_RE)) {
    const url = trimTrailingPunctuation(match[0]);
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }

  return out;
}

/** url -> ms epoch it was last seen. */
export interface RecentUrls {
  [url: string]: number;
}

export const RECENT_URL_TTL_MS = 60 * 60 * 1000; // 1h

/** Drop entries older than ttlMs relative to now. Pure -- returns a new object. */
export function pruneExpired(recent: RecentUrls, now: number, ttlMs: number = RECENT_URL_TTL_MS): RecentUrls {
  const out: RecentUrls = {};
  for (const [url, seenAt] of Object.entries(recent)) {
    if (now - seenAt < ttlMs) out[url] = seenAt;
  }
  return out;
}

/**
 * Filter candidates down to ones not already in `recent` (after pruning
 * expired entries), and return the updated recent map with all surviving
 * plus newly-seen URLs marked at `now` (a repeat sighting refreshes its TTL).
 */
export function dedupeAgainstRecent(
  candidates: string[],
  recent: RecentUrls,
  now: number,
  ttlMs: number = RECENT_URL_TTL_MS,
): { fresh: string[]; updated: RecentUrls } {
  const pruned = pruneExpired(recent, now, ttlMs);
  const fresh: string[] = [];
  const updated: RecentUrls = { ...pruned };
  for (const url of candidates) {
    if (!(url in pruned)) fresh.push(url);
    updated[url] = now;
  }
  return { fresh, updated };
}
