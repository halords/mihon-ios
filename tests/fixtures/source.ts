import { vi } from 'vitest';
import type { Source, SChapter, SManga } from '../../src/sources/Source';
export function testSource(id = 'test-source', chapterCount = 2): { source: Source; manga: SManga; chapters: SChapter[] } {
  const manga: SManga = { id: '/hero', sourceId: id, title: 'Test Hero', description: '', genres: [], coverUrl: '', status: 'Ongoing' };
  const chapters = Array.from({ length: chapterCount }, (_, i) => ({ id: '/chapter/' + (i + 1), mangaId: manga.id, name: 'Chapter ' + (i + 1), number: i + 1, dateUpload: 1700000000000 }));
  return { manga, chapters, source: { id, name: 'Test source', kind: 'extension', getPopularManga: vi.fn(async () => [manga]), getLatestUpdates: vi.fn(async () => [manga]), searchManga: vi.fn(async () => [manga]), getMangaDetails: vi.fn(async () => manga), getChapterList: vi.fn(async () => chapters), getPageList: vi.fn(async () => []) } };
}
