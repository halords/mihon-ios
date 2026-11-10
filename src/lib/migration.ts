import { getDB, libraryCategories, dispatchDataEvent, type StoredManga } from './db';
import { mangaKey, chapterKey, type SChapter, type SManga } from '../sources/Source';

export function matchMigrationChapters(old: SChapter, chapters: SChapter[]): SChapter[] {
  if (old.number < 0 || !Number.isFinite(old.number)) return [];
  const matching = chapters.filter(c => c.number === old.number);
  const sameGroup = matching.filter(c => old.scanlator && c.scanlator?.toLowerCase() === old.scanlator.toLowerCase());
  return sameGroup.length ? sameGroup : matching;
}
export async function migrateManga(originalKey: string, manga: SManga, chapters: SChapter[], keepOriginal: boolean): Promise<{ matched: number; total: number; key: string }> {
  const targetKey = mangaKey(manga.sourceId, manga.id);
  if (targetKey === originalKey) throw new Error('Choose a different source or title');
  const db = await getDB();
  const tx = db.transaction(['manga', 'chapterMeta', 'chapterState', 'history', 'library'], 'readwrite');
  try {
    const original = await tx.objectStore('manga').get(originalKey);
    if (!original) throw new Error('Original title is missing');
    const previous = await tx.objectStore('manga').get(targetKey);
    const target: StoredManga = { ...original, ...previous, key: targetKey, manga, sourceAvailable: true, updatedAt: Date.now(), migratedFrom: originalKey };
    await tx.objectStore('manga').put(target);
    for (const chapter of chapters) await tx.objectStore('chapterMeta').put({ key: chapterKey(manga.sourceId, manga.id, chapter.id), mangaKey: targetKey, chapter });
    const old = await tx.objectStore('chapterMeta').index('by-manga').getAll(originalKey);
    let matched = 0;
    for (const chapter of old) {
      const state = await tx.objectStore('chapterState').get(chapter.key);
      if (!state || !(state.read || state.bookmark || state.lastPage)) continue;
      const matches = matchMigrationChapters(chapter.chapter, chapters);
      if (matches.length) matched++;
      const history = await tx.objectStore('history').get(chapter.key);
      for (const next of matches) {
        const key = chapterKey(manga.sourceId, manga.id, next.id);
        const existing = await tx.objectStore('chapterState').get(key);
        const transferPage = matches.length === 1 ? state.lastPage : 0;
        await tx.objectStore('chapterState').put({ ...existing, key, mangaKey: targetKey,
          read: state.read || !!existing?.read, bookmark: !!state.bookmark || !!existing?.bookmark,
          lastPage: Math.max(existing?.lastPage ?? 0, transferPage), downloaded: existing?.downloaded ?? false,
          lastReadAt: Math.max(state.lastReadAt ?? 0, existing?.lastReadAt ?? 0) });
        const previousHistory = await tx.objectStore('history').get(key);
        if (history && (!previousHistory || history.updatedAt > previousHistory.updatedAt)) await tx.objectStore('history').put({
          ...history, key, mangaKey: targetKey, mangaTitle: manga.title, coverUrl: manga.coverUrl, chapterName: next.name, page: transferPage,
        });
      }
    }
    const entry = await tx.objectStore('library').get(originalKey);
    if (entry) {
      await tx.objectStore('library').put({ ...entry, key: targetKey, categories: libraryCategories(entry) });
      if (!keepOriginal) await tx.objectStore('library').delete(originalKey);
    }
    await tx.done;
    dispatchDataEvent();
    return { matched, total: old.length, key: targetKey };
  } catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
}
