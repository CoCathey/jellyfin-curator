import type { OwnedShelf, State } from "../state/types.js";

export interface RotationPolicy {
  shelfCount: number;
  rotatePerRun: number;
  fullRefresh: boolean;
}

export interface RotationDecision {
  keep: OwnedShelf[];
  retire: OwnedShelf[];
  /** How many new shelves the planner should produce so keep + new = shelfCount. */
  wanted: number;
}

/** Orphans first, then oldest first; ties broken by collection id so the
 * decision is stable. Retire count is the largest of: the configured
 * rotation, the overflow above shelfCount, and the number of orphans.
 *
 * The configured rotation applies only at capacity. Below shelfCount there is
 * already room for what the planner is about to make, so retiring a good shelf
 * to open a slot that exists would just shorten its life — after raising
 * shelfCount, the catch-up run fills the gap and touches nothing. Overflow and
 * orphans still go: they are not rotation. */
export function rotate(state: State, policy: RotationPolicy): RotationDecision {
  const ordered = [...state.shelves].sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === "orphan" ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.collectionId < b.collectionId ? -1 : a.collectionId > b.collectionId ? 1 : 0;
  });
  const overflow = Math.max(0, ordered.length - policy.shelfCount);
  const orphans = ordered.filter((s) => s.origin === "orphan").length;
  const rotation = ordered.length >= policy.shelfCount ? policy.rotatePerRun : 0;
  const retireCount = policy.fullRefresh ? ordered.length : Math.min(ordered.length, Math.max(rotation, overflow, orphans));
  const retire = ordered.slice(0, retireCount);
  const keep = ordered.slice(retireCount);
  return { keep, retire, wanted: Math.max(0, policy.shelfCount - keep.length) };
}
