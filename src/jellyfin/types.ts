export type ItemKind = "Movie" | "Series" | "BoxSet";

export interface JellyfinPerson {
  Name?: string | null;
  Type?: string | null;
  Role?: string | null;
}

export interface JellyfinNamePair {
  Name?: string | null;
  Id?: string | null;
}

export interface JellyfinUserData {
  Played?: boolean;
  IsFavorite?: boolean;
  PlayCount?: number;
}

/** The slice of Jellyfin's BaseItemDto we read. The index signature keeps every
 * other field intact for read-modify-write updates, which Jellyfin requires. */
export interface JellyfinItem {
  Id: string;
  /** Nullable in BaseItemDto, and a half-scanned item really does come back
   * without one, so every reader needs a fallback. */
  Name?: string | null;
  Type: string;
  ProductionYear?: number | null;
  Genres?: string[] | null;
  Tags?: string[] | null;
  Overview?: string | null;
  CommunityRating?: number | null;
  RunTimeTicks?: number | null;
  Studios?: JellyfinNamePair[] | null;
  People?: JellyfinPerson[] | null;
  UserData?: JellyfinUserData | null;
  /** Present per image type the item actually has ("Primary", "Thumb", "Logo"). */
  ImageTags?: Record<string, string> | null;
  /** One tag per backdrop; length is what matters, the tag itself is a cache key. */
  BackdropImageTags?: string[] | null;
  [extra: string]: unknown;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  Policy?: { IsAdministrator?: boolean | null } | null;
}

export interface JellyfinSystemInfo {
  Version?: string | null;
  ServerName?: string | null;
}
