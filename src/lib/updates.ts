import { dispatchDataEvent, getChapterMetas, getDB, getLibrary, getManga, putChapterMetas } from './db';
import { getSource } from '../sources';
import { splitMangaKey, type SChapter } from '../sources/Source';

export interface LibraryUpdate { mangaKey: string; mangaTitle: string; coverUrl: string; chapter: SChapter; foundAt: number }
export interface UpdateSnapshot { chapters: LibraryUpdate[]; lastChecked: number; checked: number; unavailable: number; failures: string[]; found: number }
const KEY = 'library:updates';
export async function getLibraryUpdates(): Promise<UpdateSnapshot | null> {
  const value = (await (await getDB()).get('metadata', KEY))?.value as Partial<UpdateSnapshot> | undefined;
  return value && Array.isArray(value.chapters) && typeof value.lastChecked === 'number' ? value as UpdateSnapshot : null;
}
export async function checkLibraryUpdates(onProgress?: (done: number, total: number) => void): Promise<UpdateSnapshot> {
  const library = await getLibrary();
  const previous = await getLibraryUpdates();
  const now = Date.now();
  const report: UpdateSnapshot = { chapters: [], lastChecked: now, checked: 0, unavailable: 0, failures: [], found: 0 };
  const found: LibraryUpdate[] = [];
  let done = 0;
  for (let i = 0; i < library.length; i += 3) {
    const results = await Promise.allSettled(library.slice(i, i + 3).map(async entry => {
      const [sourceId, mangaId] = splitMangaKey(entry.key);
      const source = getSource(sourceId);
      if (!source || sourceId === 'local' || sourceId === '0') { report.unavailable++; return; }
      const manga = await getManga(entry.key);
      if (!manga) return;
      const before = new Set((await getChapterMetas(entry.key)).map(m => m.chapter.id));
      try {
        const chapters = await source.getChapterList(mangaId);
        // Save metadata changes even when no new chapter was added.
        await putChapterMetas(sourceId, mangaId, chapters);
        for (const chapter of chapters) if (!chapter.external && !before.has(chapter.id)) found.push({ mangaKey: entry.key, mangaTitle: manga.manga.title, coverUrl: manga.manga.coverUrl, chapter, foundAt: now });
        report.checked++;
      } catch (error) { report.failures.push(manga.manga.title + ': ' + (error instanceof Error ? error.message : 'Source unavailable')); }
    }));
    for (const result of results) if (result.status === 'rejected') report.failures.push(result.reason instanceof Error ? result.reason.message : 'Unable to check a title');
    done += results.length; onProgress?.(done, library.length);
  }
  const libraryKeys = new Set(library.map(m => m.key));
  report.found = found.length;
  report.chapters = [...new Map([...(previous?.chapters ?? []), ...found].filter(c => libraryKeys.has(c.mangaKey)).map(c => [c.mangaKey + '::' + c.chapter.id, c])).values()].sort((a, b) => b.foundAt - a.foundAt || b.chapter.dateUpload - a.chapter.dateUpload).slice(0, 2000);
  await (await getDB()).put('metadata', { key: KEY, value: report });
  dispatchDataEvent();
  return report;
}
