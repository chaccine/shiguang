import { decodeStory, toLegacy } from "../../src/domain/story.ts";
import type { Snapshot } from "../../src/domain/types.ts";

/** Construct the historical simple wire representation for synthetic import tests. */
export function legacySnapshots<T extends { version: number; schemaVersion: number;
  records: { formal: Snapshot | null; draft: Snapshot | null }[]; conflictCopies: { snapshot: Snapshot }[] }>(state: T): T {
  for (const snap of [...state.records.flatMap(row => [row.formal, row.draft]), ...state.conflictCopies.map(c => c.snapshot)]) {
    if (snap?.story) {
      Object.assign(snap, toLegacy(decodeStory(snap.story)));
      delete snap.story;
    }
  }
  state.version = 1;
  state.schemaVersion = 5;
  return state;
}
