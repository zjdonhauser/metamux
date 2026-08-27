// Reads ~/.config/cmux/cmux.json (JSONC: JS-style // line comments, and in
// practice a trailing comma before the closing brace once comments are
// stripped) to extract the workspaceColors.colors named-slot -> hex
// mapping. Read-only, tolerant of a missing or malformed file.

import { readFile } from "node:fs/promises";
import { expandHome } from "./paths.ts";

const CMUX_CONFIG_PATH = expandHome("~/.config/cmux/cmux.json");

/** Strips `//` line comments, respecting string literals (so a URL like
 * "https://..." is left untouched) and escaped quotes within strings. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Removes a trailing comma before a closing `}` or `]` -- what's left
 * after stripping a commented-out last property from a JSONC file. */
export function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

/** Pulls `workspaceColors.colors` (name -> hex) out of already-parsed
 * cmux.json. null if the shape isn't there. */
export function extractNamedColorSlots(parsed: unknown): Record<string, string> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const workspaceColors = (parsed as Record<string, unknown>).workspaceColors;
  if (!workspaceColors || typeof workspaceColors !== "object") return null;
  const colors = (workspaceColors as Record<string, unknown>).colors;
  if (!colors || typeof colors !== "object") return null;

  const table: Record<string, string> = {};
  for (const [name, hex] of Object.entries(colors)) {
    if (typeof hex === "string") table[name] = hex;
  }
  return table;
}

/** Loads the named-slot -> hex color table from ~/.config/cmux/cmux.json.
 * null if the file is missing, unparseable, or has no workspaceColors. */
export async function loadCmuxNamedColorSlots(): Promise<Record<string, string> | null> {
  try {
    const raw = await readFile(CMUX_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
    return extractNamedColorSlots(parsed);
  } catch {
    return null;
  }
}
