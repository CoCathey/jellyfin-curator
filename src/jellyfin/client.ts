import { CLIENT_NAME, CLIENT_VERSION } from "../constants.js";
import type { ItemKind, JellyfinItem, JellyfinSystemInfo, JellyfinUser } from "./types.js";

export interface ItemQuery {
  includeItemTypes: ItemKind[];
  fields?: string[];
  userId?: string;
  tags?: string[];
  parentId?: string;
  isPlayed?: boolean;
  isFavorite?: boolean;
}

/** Everything the service needs from Jellyfin. The only HTTP seam. */
export interface JellyfinClient {
  getSystemInfo(): Promise<JellyfinSystemInfo>;
  listUsers(): Promise<JellyfinUser[]>;
  /** Recursive query, all pages. */
  queryItems(query: ItemQuery): Promise<JellyfinItem[]>;
  /** undefined when Jellyfin answers 404. */
  getItem(id: string): Promise<JellyfinItem | undefined>;
  /** POSTs the whole DTO. Callers must GET first and modify. */
  updateItem(item: JellyfinItem): Promise<void>;
  /** Returns the new BoxSet id. */
  createCollection(name: string, itemIds: string[]): Promise<string>;
  deleteItem(id: string): Promise<void>;
  /** undefined when the plugin is not installed (404). */
  getPluginConfiguration(pluginId: string): Promise<unknown>;
  setPluginConfiguration(pluginId: string, config: unknown): Promise<void>;
  /** POST with no body; returns the HTTP status instead of throwing. */
  postAction(path: string): Promise<number>;
  /** Raw image bytes; undefined when the item has no image of that type (404). */
  getImage(itemId: string, type: string, index?: number, maxWidth?: number): Promise<Buffer | undefined>;
  /** Replaces the item's Primary image. */
  setPrimaryImage(itemId: string, image: Buffer, contentType: string): Promise<void>;
}

export class JellyfinHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`Jellyfin responded ${status} to ${path}: ${body.slice(0, 200)}`);
    this.name = "JellyfinHttpError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ItemsPage {
  Items?: JellyfinItem[] | null;
  TotalRecordCount?: number;
}

type Query = Record<string, string | undefined>;

export class HttpJellyfinClient implements JellyfinClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly pageSize = 500,
  ) {}

  /** Jellyfin 10.11 throws "Guid can't be empty" on GET /Items/{id} when the
   * caller is an API key with no user context, so item reads carry a user id.
   * Resolved once per process: an administrator if there is one, else the
   * first user. */
  private userId?: Promise<string>;

  private resolveUserId(): Promise<string> {
    this.userId ??= this.listUsers().then((users) => {
      const chosen = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
      if (!chosen) throw new Error("Jellyfin reports no users; an API key cannot read items without one");
      return chosen.Id;
    });
    return this.userId;
  }

  getSystemInfo(): Promise<JellyfinSystemInfo> {
    return this.json<JellyfinSystemInfo>("GET", "/System/Info");
  }

  listUsers(): Promise<JellyfinUser[]> {
    return this.json<JellyfinUser[]>("GET", "/Users");
  }

  async queryItems(query: ItemQuery): Promise<JellyfinItem[]> {
    const all: JellyfinItem[] = [];
    let startIndex = 0;
    for (;;) {
      const page = await this.json<ItemsPage>("GET", "/Items", {
        recursive: "true",
        includeItemTypes: query.includeItemTypes.join(","),
        // Paging is only well defined under a stable sort: without one, an item
        // can shift between pages as we walk them and be read twice or missed.
        sortBy: "SortName",
        sortOrder: "Ascending",
        fields: query.fields?.join(","),
        userId: query.userId,
        tags: query.tags?.join(","),
        parentId: query.parentId,
        isPlayed: query.isPlayed === undefined ? undefined : String(query.isPlayed),
        isFavorite: query.isFavorite === undefined ? undefined : String(query.isFavorite),
        limit: String(this.pageSize),
        startIndex: String(startIndex),
      });
      const items = page.Items ?? [];
      all.push(...items);
      startIndex += items.length;
      const total = page.TotalRecordCount ?? all.length;
      if (items.length < this.pageSize || startIndex >= total) break;
    }
    return all;
  }

  async getItem(id: string): Promise<JellyfinItem | undefined> {
    const path = `/Items/${id}`;
    const res = await this.send("GET", path, { userId: await this.resolveUserId() });
    if (res.status === 404) return undefined;
    await this.assertOk(res, path);
    return (await res.json()) as JellyfinItem;
  }

  async updateItem(item: JellyfinItem): Promise<void> {
    await this.ok("POST", `/Items/${item.Id}`, undefined, item);
  }

  async createCollection(name: string, itemIds: string[]): Promise<string> {
    const result = await this.json<{ Id: string }>("POST", "/Collections", { name, ids: itemIds.join(",") });
    return result.Id;
  }

  async deleteItem(id: string): Promise<void> {
    await this.ok("DELETE", `/Items/${id}`);
  }

  async getPluginConfiguration(pluginId: string): Promise<unknown> {
    const path = `/Plugins/${pluginId}/Configuration`;
    const res = await this.send("GET", path);
    if (res.status === 404) return undefined;
    await this.assertOk(res, path);
    return (await res.json()) as unknown;
  }

  async setPluginConfiguration(pluginId: string, config: unknown): Promise<void> {
    await this.ok("POST", `/Plugins/${pluginId}/Configuration`, undefined, config);
  }

  async postAction(path: string): Promise<number> {
    const res = await this.send("POST", path);
    return res.status;
  }

  async getImage(itemId: string, type: string, index = 0, maxWidth?: number): Promise<Buffer | undefined> {
    const path = `/Items/${itemId}/Images/${type}/${index}`;
    const res = await this.send("GET", path, { maxWidth: maxWidth?.toString() });
    if (res.status === 404) return undefined;
    await this.assertOk(res, path);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Jellyfin's image endpoint takes the bytes base64-encoded in the body, with
   * the image's own content type on the request — not multipart, and not raw. */
  async setPrimaryImage(itemId: string, image: Buffer, contentType: string): Promise<void> {
    const path = `/Items/${itemId}/Images/Primary`;
    const res = await this.fetchImpl(this.baseUrl + path, {
      method: "POST",
      headers: { Authorization: this.authorization(), "Content-Type": contentType },
      body: image.toString("base64"),
    });
    await this.assertOk(res, path);
  }

  private authorization(): string {
    return `MediaBrowser Token="${this.apiKey}", Client="${CLIENT_NAME}", Device="curator", DeviceId="${CLIENT_NAME}", Version="${CLIENT_VERSION}"`;
  }

  private send(method: string, path: string, query?: Query, body?: unknown): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { Authorization: this.authorization(), Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async assertOk(res: Response, path: string): Promise<void> {
    if (!res.ok) throw new JellyfinHttpError(res.status, path, await res.text());
  }

  private async ok(method: string, path: string, query?: Query, body?: unknown): Promise<void> {
    const res = await this.send(method, path, query, body);
    await this.assertOk(res, path);
  }

  private async json<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const res = await this.send(method, path, query, body);
    await this.assertOk(res, path);
    return (await res.json()) as T;
  }
}
