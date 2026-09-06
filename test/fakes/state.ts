import type { StateStore } from "../../src/state/store.js";
import { emptyState, type State } from "../../src/state/types.js";

/** In-memory store that counts saves, so tests can assert "saved after every write". */
export class MemoryStateStore implements StateStore {
  saves = 0;

  constructor(public state: State = emptyState()) {}

  async load(): Promise<State> {
    return structuredClone(this.state);
  }

  async save(state: State): Promise<void> {
    this.state = structuredClone(state);
    this.saves += 1;
  }
}
