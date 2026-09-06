import { JellyfinHttpError, type ItemQuery, type JellyfinClient } from "../../src/jellyfin/client.js";
import type { ItemKind, JellyfinItem, JellyfinSystemInfo, JellyfinUser } from "../../src/jellyfin/types.js";

/** In-memory Jellyfin. Mirrors the semantics the service relies on: type and
 * tag filtering, per-user played/favourite flags, BoxSet creation, 404s. */
export class FakeJellyfinClient implements JellyfinClient {
  readonly items = new Map<string, JellyfinItem>();
  users: JellyfinUser[] = [];
  readonly played = new Map<string, Set<string>>();
  readonly favorites = new Map<string, Set<string>>();
  readonly collections = new Map<string, { name: string; itemIds: string[] }>();
  readonly pluginConfigs = new Map<string, unknown>();
  readonly deleted: string[] = [];
  readonly actions: string[] = [];
  readonly failCreateFor = new Set<string>();
  /** `${itemId}/${type}/${index}` -> bytes, for both directions of image traffic. */
  readonly images = new Map<string, Buffer>();
  readonly uploadedPrimary = new Map<string, { image: Buffer; contentType: string }>();
  actionStatus = 200;
  private nextId = 1;

  addItem(item: JellyfinItem): void {
    this.items.set(item.Id, structuredClone(item));
  }

  async getSystemInfo(): Promise<JellyfinSystemInfo> {
    return { Version: "10.11.10", ServerName: "fake" };
  }

  async listUsers(): Promise<JellyfinUser[]> {
    return structuredClone(this.users);
  }

  async queryItems(query: ItemQuery): Promise<JellyfinItem[]> {
    let list = [...this.items.values()].filter((i) => query.includeItemTypes.includes(i.Type as ItemKind));
    if (query.tags) list = list.filter((i) => query.tags!.every((t) => (i.Tags ?? []).includes(t)));
    if (query.userId !== undefined) {
      const played = this.played.get(query.userId) ?? new Set<string>();
      const favorites = this.favorites.get(query.userId) ?? new Set<string>();
      if (query.isPlayed) list = list.filter((i) => played.has(i.Id));
      if (query.isFavorite) list = list.filter((i) => favorites.has(i.Id));
      list = list.map((i) => ({ ...i, UserData: { Played: played.has(i.Id), IsFavorite: favorites.has(i.Id) } }));
    }
    return list.map((i) => structuredClone(i));
  }

  async getItem(id: string): Promise<JellyfinItem | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async updateItem(item: JellyfinItem): Promise<void> {
    if (!this.items.has(item.Id)) throw new JellyfinHttpError(404, `/Items/${item.Id}`, "");
    this.items.set(item.Id, structuredClone(item));
  }

  /** Jellyfin derives a BoxSet's id from its name-based path, so POST /Collections
   * with a name that already exists is an upsert: it merges the ids into that
   * collection and hands back its existing id. Mirrored here because the service
   * has to survive it. */
  async createCollection(name: string, itemIds: string[]): Promise<string> {
    if (this.failCreateFor.has(name)) throw new JellyfinHttpError(500, "/Collections", `refused to create ${name}`);
    const existing = [...this.items.values()].find((i) => i.Type === "BoxSet" && (i.Name ?? "").toLowerCase() === name.toLowerCase());
    if (existing) {
      const prior = this.collections.get(existing.Id)?.itemIds ?? [];
      this.collections.set(existing.Id, { name: existing.Name ?? name, itemIds: [...new Set([...prior, ...itemIds])] });
      return existing.Id;
    }
    const id = `boxset-${this.nextId++}`;
    this.collections.set(id, { name, itemIds: [...itemIds] });
    this.items.set(id, { Id: id, Name: name, Type: "BoxSet", Tags: [] });
    return id;
  }

  async deleteItem(id: string): Promise<void> {
    if (!this.items.has(id)) throw new JellyfinHttpError(404, `/Items/${id}`, "");
    this.items.delete(id);
    this.collections.delete(id);
    this.deleted.push(id);
  }

  async getPluginConfiguration(pluginId: string): Promise<unknown> {
    return this.pluginConfigs.has(pluginId) ? structuredClone(this.pluginConfigs.get(pluginId)) : undefined;
  }

  async setPluginConfiguration(pluginId: string, config: unknown): Promise<void> {
    this.pluginConfigs.set(pluginId, structuredClone(config));
  }

  async postAction(path: string): Promise<number> {
    this.actions.push(path);
    return this.actionStatus;
  }

  async getImage(itemId: string, type: string, index = 0): Promise<Buffer | undefined> {
    return this.images.get(`${itemId}/${type}/${index}`);
  }

  async setPrimaryImage(itemId: string, image: Buffer, contentType: string): Promise<void> {
    if (!this.items.has(itemId)) throw new JellyfinHttpError(404, `/Items/${itemId}/Images/Primary`, "not found");
    this.uploadedPrimary.set(itemId, { image, contentType });
    const item = this.items.get(itemId)!;
    this.items.set(itemId, { ...item, ImageTags: { ...(item.ImageTags ?? {}), Primary: "written" } });
  }
}
