import type { Harness } from "./identity.ts";

export interface Proc {
  pid: number;
  ppid: number;
  command: string;
}

const BINARIES: Record<string, Harness["kind"]> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
};

/**
 * Classifies one command line, matching on the BINARY rather than anywhere in
 * the string. `grep claude ...` is not a harness, and neither is the desktop
 * app at /Applications/Claude.app/... whose basename is capitalised.
 */
export function classifyCommand(command: string): Harness | null {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  const basename = argv0.split("/").pop() ?? "";
  const kind = BINARIES[basename];
  if (!kind) return null;
  const match = command.match(/--session-id\s+([0-9a-fA-F-]{36})/);
  return { kind, sessionId: match ? match[1] : null };
}

/**
 * Walks the descendants of `rootPid` breadth-first and returns the first
 * harness found. The walk must be recursive: `pane -> zsh -> claude` is the
 * normal shape, so scanning direct children only misses most live sessions.
 */
export function findHarness(procs: Proc[], rootPid: number): Harness | null {
  const childrenOf = new Map<number, Proc[]>();
  for (const p of procs) {
    const found = childrenOf.get(p.ppid);
    if (found) found.push(p);
    else childrenOf.set(p.ppid, [p]);
  }

  // `seen` also guards against a cyclic process table, which would otherwise
  // spin the daemon's poll forever.
  const seen = new Set<number>([rootPid]);
  let frontier = childrenOf.get(rootPid) ?? [];

  while (frontier.length > 0) {
    const next: Proc[] = [];
    for (const proc of frontier) {
      if (seen.has(proc.pid)) continue;
      seen.add(proc.pid);
      const harness = classifyCommand(proc.command);
      if (harness) return harness;
      next.push(...(childrenOf.get(proc.pid) ?? []));
    }
    frontier = next;
  }
  return null;
}

/** Parses `ps -eo pid=,ppid=,command=` output. Split out so findHarness stays pure. */
export function parsePsOutput(stdout: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    procs.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return procs;
}
