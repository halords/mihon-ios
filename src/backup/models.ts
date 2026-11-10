// Field numbers follow Mihon's kotlinx.serialization models, verified at
// mihonapp/mihon commit 524fa53043f2f5b2321ea13027e44f093ab4245c.
export interface ParsedChapter {
  url: string; name: string; scanlator: string; read: boolean; bookmark: boolean;
  lastPageRead: number; dateFetch: number; dateUpload: number;
  chapterNumber: number; sourceOrder: number; memo: string;
}
export interface ParsedHistory { url: string; lastRead: number; readDuration: number }
export interface ParsedTracking {
  syncId: number; libraryId: string; mediaId: string; mediaIdInt: number;
  trackingUrl: string; title: string; lastChapterRead: number; totalChapters: number;
  score: number; status: number; startedReadingDate: number; finishedReadingDate: number; private: boolean;
}
export interface ParsedManga {
  source: bigint; url: string; title: string; author: string; artist: string;
  description: string; genres: string[]; status: number; thumbnailUrl: string;
  dateAdded: number; viewer: number; viewerFlags: number | null; chapterFlags: number;
  chapters: ParsedChapter[]; categories: bigint[]; history: ParsedHistory[];
  tracking: ParsedTracking[]; favorite: boolean; updateStrategy: number;
  favoriteModifiedAt: number; excludedScanlators: string[]; notes: string;
  initialized: boolean; memo: string; nextUpdate: number;
}
export interface ParsedCategory { name: string; order: bigint; id: bigint; flags: bigint }
export interface ParsedSource { name: string; sourceId: bigint }
export interface ParsedPreference {
  key: string; type: string; value: number | string | boolean | string[] | null;
  rawValue: string;
}
export interface ParsedSourcePreferences { sourceKey: string; prefs: ParsedPreference[] }
export interface ParsedExtensionStore {
  indexUrl: string; name: string; badgeLabel: string; signingKey: string;
  contactWebsite: string; contactDiscord: string; isLegacy: boolean; extensionListUrl: string;
}
export interface ParsedBackup {
  manga: ParsedManga[]; categories: ParsedCategory[]; sources: ParsedSource[];
  preferences: ParsedPreference[]; sourcePreferences: ParsedSourcePreferences[];
  extensionStores: ParsedExtensionStore[]; unknownFields: number;
}

export function jsonSafe<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v)) as Record<string, unknown>;
}
