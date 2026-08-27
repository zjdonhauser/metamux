// Pure palette-index allocation for colorMode: "palette" (palette.ts's
// static, ordered {hex, chromeColor} list). No I/O, no Registry/
// WorkspaceRef dependency -- operates on a generic snapshot of "holders"
// so it's fully unit-testable in isolation. registry.ts wires this
// against real WorkspaceRef data at attachment time (Registry.markAttached).

export interface PaletteHolder {
  /** The allocation unit an identity is keyed by: a title in groupBy:
   * "title" (a whole alias shares one claim), a real workspace id in
   * groupBy: "workspace". */
  identityKey: string;
  /** !archived && attachedAt !== null -- only a live, attached holder can
   * hold a claim; an archived or detached one has released it. */
  live: boolean;
  paletteIndex: number | null;
}

/** Resolves the palette index `identityKey` should hold, given every other
 * current holder (including, harmlessly, any of identityKey's own other
 * refs -- self-matches are excluded from the "held" set so an identity
 * never blocks its own claim). Pure, idempotent, and stable: an identity
 * that already holds a live index keeps it -- never reshuffled by another
 * identity's claim or release, even if a lower index has since freed up.
 * Otherwise claims the LOWEST index not currently held by any OTHER live
 * identity. A released identity (live: false) has no memory of its prior
 * index -- re-attaching claims fresh and may land on a different color,
 * by design. Returns null only if every index in a palette of
 * `paletteSize` is already held by other identities -- with palette.ts's
 * entries 10+ reusing Chrome colors, this never actually happens in
 * practice, but the function stays total rather than assuming it can't. */
export function claimPaletteIndex(identityKey: string, holders: PaletteHolder[], paletteSize: number): number | null {
  const existing = holders.find((h) => h.identityKey === identityKey && h.live && h.paletteIndex !== null);
  if (existing) return existing.paletteIndex;

  const held = new Set<number>();
  for (const h of holders) {
    if (h.identityKey === identityKey) continue;
    if (h.live && h.paletteIndex !== null) held.add(h.paletteIndex);
  }
  for (let i = 0; i < paletteSize; i++) {
    if (!held.has(i)) return i;
  }
  return null;
}
