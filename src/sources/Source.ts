export type MangaStatus = 'Ongoing' | 'Completed' | 'On Hold' | 'Cancelled' | 'Licensed' | 'Publishing Finished' | 'Unknown';

export interface SManga {
  id: string; // source-local id
  sourceId: string;
  title: string;
  author?: string;
  artist?: string;
  status: MangaStatus;
  description: string;
  genres: string[];
  coverUrl: string; // may be a data URI
  url?: string;
  sourceName?: string;
}

export interface SChapter {
  id: string; // source-local chapter id
  mangaId: string;
  name: string;
  number: number;
  dateUpload: number; // epoch ms
  external?: boolean; // hosted outside the source API; not readable in-app
  url?: string;
  scanlator?: string;
  dateFetch?: number;
  sourceOrder?: number;
  backendId?: number;
  memo?: string;
}

export interface MangaPage {
  imageUrl: string;
  cachedKey?: string; // Cache Storage request key; loaded near the viewport.
  width?: number;
  height?: number;
}

export interface Source {
  id: string;
  name: string;
  lang?: string;
  kind?: 'builtin' | 'extension' | 'suwayomi';
  supportsLatest?: boolean;
  baseUrl?: string;
  getPopularManga(page: number): Promise<SManga[]>;
  getLatestUpdates(page: number): Promise<SManga[]>;
  searchManga(query: string, page: number): Promise<SManga[]>;
  getMangaDetails(id: string): Promise<SManga>;
  getChapterList(mangaId: string): Promise<SChapter[]>;
  getPageList(chapterId: string, mangaId?: string, signal?: AbortSignal): Promise<MangaPage[]>;
}

export function mangaKey(sourceId: string, mangaId: string): string {
  return `${sourceId}::${mangaId}`;
}

export function splitMangaKey(key: string): [string, string] {
  const separator = key.indexOf('::');
  if (separator < 1) throw new Error('Invalid manga key');
  return [key.slice(0, separator), key.slice(separator + 2)];
}

export function compareChapters(a: SChapter, b: SChapter): number {
  if (a.number !== b.number && a.number >= 0 && b.number >= 0) return a.number - b.number;
  if (a.sourceOrder !== undefined && b.sourceOrder !== undefined) return b.sourceOrder - a.sourceOrder;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

export function chapterKey(
  sourceId: string,
  mangaId: string,
  chapterId: string,
): string {
  return `${sourceId}::${mangaId}::${chapterId}`;
}

export const CATEGORIES = [
  'Default',
  'Reading',
  'Completed',
  'On Hold',
  'Dropped',
] as const;

export type Category = (typeof CATEGORIES)[number];
