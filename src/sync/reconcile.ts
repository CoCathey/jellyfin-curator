import type { OwnedShelf, State } from "../state/types.js";

export interface ReconcileResult {
  state: State;
  /** In state, but Jellyfin no longer has them (someone deleted by hand). */
  dropped: OwnedShelf[];
  /** Tagged in Jellyfin, unknown to state (state file lost, or a hand-added tag). */
  adopted: OwnedShelf[];
}

/** Make state agree with what Jellyfin actually holds under our tag. */
export function reconcileOwned(state: State, tagged: Array<{ Id: string; Name: string }>, now: Date): ReconcileResult {
  const taggedIds = new Set(tagged.map((t) => t.Id));
  const known = new Set(state.shelves.map((s) => s.collectionId));
  const dropped = state.shelves.filter((s) => !taggedIds.has(s.collectionId));
  const kept = state.shelves.filter((s) => taggedIds.has(s.collectionId));
  const adopted: OwnedShelf[] = tagged
    .filter((t) => !known.has(t.Id))
    .map((t) => ({ collectionId: t.Id, title: t.Name, blurb: "", itemIds: [], createdAt: now.toISOString(), origin: "orphan" }));
  return { state: { ...state, shelves: [...kept, ...adopted] }, dropped, adopted };
}
