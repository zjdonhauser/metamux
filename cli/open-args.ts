// Pure argument parsing for `metamux open <url> [--active]`.

export interface ParsedOpenArgs {
  url: string | undefined;
  active: boolean;
}

/** `--active` means "target the visually active workspace explicitly"
 * (omit cmuxWorkspaceId from POST /open, letting the daemon fall back to
 * its own activeId) regardless of $CMUX_WORKSPACE_ID -- without it, the
 * caller's own shell workspace stays the default (existing behavior).
 * Order-independent: `--active` may appear before or after the url. */
export function parseOpenArgs(args: string[]): ParsedOpenArgs {
  const active = args.includes("--active");
  const url = args.find((a) => a !== "--active");
  return { url, active };
}
