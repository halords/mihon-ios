export type MangaStatus = 'Ongoing' | 'Completed' | 'On Hold' | 'Unknown';

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
}

export interface SChapter {
  id: string; // source-local chapter id
  mangaId: string;
  name: string;
  number: number;
  dateUpload: number; // epoch ms
  external?: boolean; // hosted outside the source API; not readable in-app
}

export interface MangaPage {
  imageUrl: string;
}

export interface Source {
  id: string;
  name: string;
  getPopularManga(page: number): Promise<SManga[]>;
  getLatestUpdates(page: number): Promise<SManga[]>;
  searchManga(query: string, page: number): Promise<SManga[]>;
  getMangaDetails(id: string): Promise<SManga>;
  getChapterList(mangaId: string): Promise<SChapter[]>;
  getPageList(chapterId: string): Promise<MangaPage[]>;
}

export function mangaKey(sourceId: string, mangaId: string): string {
  return `${sourceId}::${mangaId}`;
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
