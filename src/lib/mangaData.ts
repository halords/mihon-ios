import { getManga, getChapterMetas, getChapterStates, getLibraryEntry, getHistoryForManga, putChapterMetas, putManga } from './db';
import { getSource } from '../sources';
import { splitMangaKey } from '../sources/Source';

export async function loadMangaData(key: string, refresh = false) {
  const [sourceId, mangaId] = splitMangaKey(key);
  const source = getSource(sourceId);
  let stored = await getManga(key);
  let metas = await getChapterMetas(key);
  let networkError: string | undefined;
  if (source && (refresh || !stored || !metas.length) && navigator.onLine !== false) {
    const [details, chapters] = await Promise.allSettled([source.getMangaDetails(mangaId), source.getChapterList(mangaId)]);
    if (details.status === 'fulfilled') { await putManga({ ...details.value, id: mangaId, sourceId }, true); stored = await getManga(key); }
    else networkError = details.reason instanceof Error ? details.reason.message : 'Unable to refresh details';
    if (chapters.status === 'fulfilled') { await putChapterMetas(sourceId, mangaId, chapters.value); metas = await getChapterMetas(key); }
    else networkError = chapters.reason instanceof Error ? chapters.reason.message : 'Unable to refresh chapters';
  }
  if (!stored) throw new Error(networkError ?? 'This title has not been saved on this device');
  const [states, entry, history] = await Promise.all([getChapterStates(key), getLibraryEntry(key), getHistoryForManga(key)]);
  return { stored, manga: stored.manga, chapters: metas.map(m => m.chapter),
    stateByKey: Object.fromEntries(states.map(s => [s.key, s])), entry,
    history: history.filter(h => h.mangaKey === key), sourceAvailable: !!source, networkError };
}
