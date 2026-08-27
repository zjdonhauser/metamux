// Pure guard for F9 reverse sync: decides whether a userActivatedGroup
// frame from the extension should trigger a `cmux rpc workspace.select`
// call. Kept separate from the RPC call itself so the decision is
// testable without a live cmux socket.

export interface ReverseSyncGuardInput {
  reverseSyncEnabled: boolean;
  socketFeaturesEnabled: boolean;
  requestedId: string;
  activeId: string | null;
}

export function shouldReverseSyncSelect(input: ReverseSyncGuardInput): boolean {
  if (!input.reverseSyncEnabled) return false;
  if (!input.socketFeaturesEnabled) return false;
  if (input.requestedId === input.activeId) return false;
  return true;
}
