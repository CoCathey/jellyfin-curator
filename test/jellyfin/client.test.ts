import { describe, expect, it } from "vitest";
import { HttpJellyfinClient, JellyfinHttpError, type FetchLike } from "../../src/jellyfin/client.js";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface Canned {
  status?: number;
  json?: unknown;
  text?: string;
}

function fakeFetch(responses: Canned[]): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url: new URL(url),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = responses.shift() ?? { status: 200, json: {} };
    const body = next.text ?? JSON.stringify(next.json ?? {});
    return new Response(body === "" ? null : body, {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

describe("HttpJellyfinClient", () => {
  it("sends the MediaBrowser token header and builds the query string", async () => {
    const { calls, fetchImpl } = fakeFetch([{ json: { Items: [], TotalRecordCount: 0 } }]);
    const client = new HttpJellyfinClient("http://jf:8096", "secret", fetchImpl);
    await client.queryItems({ includeItemTypes: ["Movie", "Series"], fields: ["Genres", "Tags"], userId: "u1", isPlayed: true });
    const call = calls[0]!;
    expect(call.headers.Authorization).toContain('MediaBrowser Token="secret"');
    expect(call.headers.Authorization).toContain('Client="jellyfin-curator"');
    expect(call.url.pathname).toBe("/Items");
    expect(call.url.searchParams.get("recursive")).toBe("true");
    expect(call.url.searchParams.get("includeItemTypes")).toBe("Movie,Series");
    expect(call.url.searchParams.get("fields")).toBe("Genres,Tags");
    expect(call.url.searchParams.get("userId")).toBe("u1");
    expect(call.url.searchParams.get("isPlayed")).toBe("true");
    expect(call.url.searchParams.has("isFavorite")).toBe(false);
    expect(call.url.searchParams.has("tags")).toBe(false);
    // Paging without a sort is undefined in Jellyfin: an item can move between
    // pages while we walk them and be seen twice or not at all.
    expect(call.url.searchParams.get("sortBy")).toBe("SortName");
    expect(call.url.searchParams.get("sortOrder")).toBe("Ascending");
  });

  it("pages through /Items until every record is fetched", async () => {
    const page = (ids: string[]): Canned => ({
      json: { Items: ids.map((Id) => ({ Id, Name: Id, Type: "Movie" })), TotalRecordCount: 5 },
    });
    const { calls, fetchImpl } = fakeFetch([page(["a", "b"]), page(["c", "d"]), page(["e"])]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl, 2);
    const items = await client.queryItems({ includeItemTypes: ["Movie"] });
    expect(items.map((i) => i.Id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls.map((c) => c.url.searchParams.get("startIndex"))).toEqual(["0", "2", "4"]);
  });

  it("creates a collection and returns its id", async () => {
    const { calls, fetchImpl } = fakeFetch([{ json: { Id: "box-1" } }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await expect(client.createCollection("Heists & Chaos", ["m1", "m2"])).resolves.toBe("box-1");
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/Collections");
    expect(call.url.searchParams.get("name")).toBe("Heists & Chaos");
    expect(call.url.searchParams.get("ids")).toBe("m1,m2");
  });

  it("posts the whole item back on updateItem", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 204, text: "" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await client.updateItem({ Id: "box-1", Name: "X", Type: "BoxSet", Tags: ["jellyfin-curator"], Extra: 1 });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/Items/box-1");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({ Id: "box-1", Name: "X", Type: "BoxSet", Tags: ["jellyfin-curator"], Extra: 1 });
  });

  it("deletes by id", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 204, text: "" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await client.deleteItem("box-1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.pathname).toBe("/Items/box-1");
  });

  it("returns undefined for a missing item or plugin config, throws on other errors", async () => {
    const { fetchImpl } = fakeFetch([
      { json: [{ Id: "u1", Name: "Admin", Policy: { IsAdministrator: true } }] },
      { status: 404, text: "" },
      { status: 404, text: "" },
      { status: 401, text: "nope" },
    ]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await expect(client.getItem("nope")).resolves.toBeUndefined();
    await expect(client.getPluginConfiguration("p")).resolves.toBeUndefined();
    const err = await client.getSystemInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JellyfinHttpError);
    expect((err as JellyfinHttpError).status).toBe(401);
    expect((err as JellyfinHttpError).path).toBe("/System/Info");
  });

  it("reads an item as an administrator: Jellyfin 10.11 rejects /Items/{id} without a userId on an API key", async () => {
    const users = [
      { Id: "u-guest", Name: "Guest", Policy: { IsAdministrator: false } },
      { Id: "u-admin", Name: "Admin", Policy: { IsAdministrator: true } },
    ];
    const { calls, fetchImpl } = fakeFetch([{ json: users }, { json: { Id: "box-1", Name: "X", Type: "BoxSet" } }, { json: { Id: "box-2", Name: "Y", Type: "BoxSet" } }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await expect(client.getItem("box-1")).resolves.toMatchObject({ Id: "box-1" });
    await expect(client.getItem("box-2")).resolves.toMatchObject({ Id: "box-2" });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/Users", "/Items/box-1", "/Items/box-2"]);
    expect(calls[1]!.url.searchParams.get("userId")).toBe("u-admin");
    expect(calls[2]!.url.searchParams.get("userId")).toBe("u-admin");
  });

  it("falls back to the first user when nobody is an administrator, and fails clearly with no users", async () => {
    const { calls, fetchImpl } = fakeFetch([{ json: [{ Id: "u-only", Name: "Solo" }] }, { json: { Id: "box-1", Name: "X", Type: "BoxSet" } }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await client.getItem("box-1");
    expect(calls[1]!.url.searchParams.get("userId")).toBe("u-only");
    const empty = new HttpJellyfinClient("http://jf:8096", "k", fakeFetch([{ json: [] }]).fetchImpl);
    await expect(empty.getItem("box-1")).rejects.toThrow(/no users/);
  });

  it("writes plugin configuration as JSON", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 204, text: "" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await client.setPluginConfiguration("abc", { Sections: [] });
    expect(calls[0]!.url.pathname).toBe("/Plugins/abc/Configuration");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ Sections: [] });
  });

  it("postAction returns the status without throwing", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 404, text: "" }]);
    const client = new HttpJellyfinClient("http://jf:8096", "k", fetchImpl);
    await expect(client.postAction("/HomeScreen/BustCache")).resolves.toBe(404);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/HomeScreen/BustCache");
  });
});
