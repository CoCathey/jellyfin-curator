import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StateSchema, emptyState, type State } from "./types.js";

export interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

/** Ownership lives here. Writes are atomic (temp file + rename) because a
 * half-written state file would make the next run forget collections it owns. */
export class JsonFileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<State> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
    return StateSchema.parse(JSON.parse(raw));
  }

  async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, this.path);
  }
}
