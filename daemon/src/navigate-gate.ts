// SSRF gate for Page.navigate (docs/protocol.md, "Workspace-scoped browser
// automation"): an agent driving the user's real, cookied Chrome profile
// must never be able to read an internal host through those cookies.
// Pure decision, DNS-injected -- the extension can't resolve DNS itself
// (a hostname pointing at 10.x is invisible to it), so this lives
// daemon-side and takes pre-resolved IPs as input; the I/O wrapper
// (main.ts/server.ts) does the actual `dns.resolve` and PortsTracker
// lookup. Known limitation, NOT built this round: a permitted URL can
// itself redirect to an internal host post-navigate -- catching that needs
// the CDP Network domain's request-intercept, out of scope here.

export type NavigateDecision = { action: "allow" } | { action: "block"; reason: string };

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function inCidr(ipInt: number, base: string, prefixLen: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// RFC 1918 private ranges, loopback, link-local (covers the 169.254.169.254
// cloud metadata address), CGNAT, and the multicast/reserved top of the
// space -- everything an agent must never reach through the user's cookies.
const IPV4_BLOCKED_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (RFC 6598)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, includes cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false; // not IPv4 -- isBlockedIPv6 handles it
  return IPV4_BLOCKED_RANGES.some(([base, len]) => inCidr(n, base, len));
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isBlockedIPv4(mapped[1]!); // IPv4-mapped -- unwrap and re-check
  return false;
}

/** True if `ip` (v4 or v6, as returned by dns.resolve) is a loopback,
 * private, link-local, CGNAT, or reserved address -- anything an agent
 * navigating on the user's behalf must not reach. */
function isPrivateOrReserved(ip: string): boolean {
  return isBlockedIPv4(ip) || isBlockedIPv6(ip);
}

/** Decides whether an agent-driven Page.navigate to `url` is allowed.
 *
 * 1. Scheme must be http/https -- file:, chrome:, chrome-extension:, etc.
 *    are always blocked regardless of host.
 * 2. A loopback hostname (localhost/127.0.0.1/::1) is allowed ONLY on a
 *    port in `observedLocalhostPorts` -- PortsTracker's own observed
 *    metamux ports allowlist (docs/protocol.md, "Ports watcher"). This is
 *    how a dev server the human is already running stays reachable
 *    without opening loopback to everything.
 * 3. Any other hostname is allowed only if EVERY IP in `resolvedIps`
 *    (the hostname's real DNS resolution, done by the caller) is public --
 *    blocking if ANY resolved IP is private defends against DNS
 *    rebinding (a hostname that resolves differently between the gate's
 *    check and the browser's own lookup). An EMPTY resolvedIps list (DNS
 *    resolution failed) fails CLOSED, not open. */
export function decideNavigate(url: string, observedLocalhostPorts: number[], resolvedIps: string[]): NavigateDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { action: "block", reason: "unparseable URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { action: "block", reason: `scheme "${parsed.protocol}" is not allowed (http/https only)` };
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;

  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    return observedLocalhostPorts.includes(port)
      ? { action: "allow" }
      : { action: "block", reason: `localhost port ${port} is not in the observed metamux ports allowlist` };
  }

  if (resolvedIps.length === 0) {
    return { action: "block", reason: "could not resolve hostname (failing closed)" };
  }
  const blockedIp = resolvedIps.find(isPrivateOrReserved);
  if (blockedIp) {
    return { action: "block", reason: `resolves to a private/reserved address (${blockedIp})` };
  }
  return { action: "allow" };
}
