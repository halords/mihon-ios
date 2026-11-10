import { gzipSync } from 'fflate';
import { getCategories, getDB, libraryCategories, type StoredManga } from '../lib/db';
import { loadSettings, type ReaderMode } from '../lib/settings';
import { getSource } from '../sources';
import { blobPart } from '../lib/bytes';
import { MANGADEX_MIHON_ID, readerModeFromFlags } from './tachibk';
import { encodeTachibk } from './writer';
import type { ParsedBackup, ParsedChapter, ParsedManga, ParsedPreference } from './models';

function sourceId(m: StoredManga): bigint | undefined {
  if (m.manga.sourceId === 'local') return 0n;
  if (m.manga.sourceId === 'mangadex') {
    if (!m.migratedFrom && /^mangadex\b/i.test(String(m.mihon?.sourceName ?? '')) && typeof m.mihon?.source === 'string') return BigInt(m.mihon.source);
    return BigInt(MANGADEX_MIHON_ID);
  }
  if (/^-?\d+$/.test(m.manga.sourceId)) {
    const id = BigInt(m.manga.sourceId);
    if (id >= -(1n << 63n) && id < (1n << 63n)) return id;
  }
}
const statusNumbers = { Unknown: 0, Ongoing: 1, Completed: 2, Licensed: 3, 'Publishing Finished': 4, Cancelled: 5, 'On Hold': 6 };
const modes: Record<ReaderMode, number> = { paged: 1, rtl: 2, vertical: 3 };
function nativeUrl(source: string, id: string, url?: string): string { return url || (source === 'mangadex' ? `/manga/${id}` : id); }
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) { const id = key(item); const group = groups.get(id) ?? []; group.push(item); groups.set(id, group); }
  return groups;
}

export async function createMihonBackup(): Promise<{ file: Blob; mangaCount: number; libraryCount: number }> {
  const db = await getDB();
  const categories = (await getCategories()).filter(c => c.name !== 'Default');
  const tx = db.transaction(['manga', 'library', 'chapterMeta', 'chapterState', 'history', 'metadata'], 'readonly');
  const [manga, library, metas, states, history, metadata] = await Promise.all([
    tx.objectStore('manga').getAll(), tx.objectStore('library').getAll(), tx.objectStore('chapterMeta').getAll(),
    tx.objectStore('chapterState').getAll(), tx.objectStore('history').getAll(), tx.objectStore('metadata').getAll(),
  ]);
  await tx.done;
  const entries = new Map(library.map(entry => [entry.key, entry]));
  const chapterStates = new Map(states.map(state => [state.key, state]));
  const chapterGroups = groupBy(metas, chapter => chapter.mangaKey);
  const historyGroups = groupBy(history, h => h.mangaKey);
  const records = new Map(metadata.map(record => [record.key, record.value]));
  const array = <T,>(key: string): T[] => Array.isArray(records.get(key)) ? records.get(key) as T[] : [];
  const incompatible = manga.filter(m => entries.has(m.key) && sourceId(m) === undefined);
  if (incompatible.length) throw new Error(`${incompatible.length} library titles use browser-only sources that Mihon cannot restore. Keep a JSON backup, or migrate these titles to a Mihon-compatible source before exporting .tachibk.`);
  const categoryOrders = new Map(categories.map((c, i) => [c.name, BigInt(i + 1)]));
  const backup: ParsedBackup = {
    manga: [], sources: [], categories: categories.map((c, i) => ({ name: c.name, order: BigInt(i + 1), id: BigInt(i + 1), flags: BigInt(c.flags ?? 0) })),
    preferences: array<ParsedPreference>('mihon:preferences'), sourcePreferences: array('mihon:source-preferences'),
    extensionStores: array('mihon:extension-stores'), unknownFields: 0,
  };
  const sourceNames = new Map(array<{ sourceId: string; name: string }>('mihon:sources').map(s => [s.sourceId, s.name]));
  for (const m of manga) {
    const source = sourceId(m);
    const entry = entries.get(m.key);
    if (source === undefined || !entry && !m.mihon && !historyGroups.has(m.key)) continue;
    const previous = (m.mihon ?? {}) as Partial<ParsedManga>;
    const dex = m.manga.sourceId === 'mangadex';
    const chapters: ParsedChapter[] = (chapterGroups.get(m.key) ?? []).filter(c => !c.chapter.external).map((c, index) => {
      const state = chapterStates.get(c.key);
      return { url: c.chapter.url || (dex ? `/chapter/${c.chapter.id}` : c.chapter.id), name: c.chapter.name, scanlator: c.chapter.scanlator ?? '',
        read: state?.read ?? false, bookmark: state?.bookmark ?? false, lastPageRead: state?.lastPage ?? 0,
        dateFetch: c.chapter.dateFetch ?? 0, dateUpload: c.chapter.dateUpload, chapterNumber: c.chapter.number, sourceOrder: c.chapter.sourceOrder ?? index, memo: c.chapter.memo ?? '' };
    });
    const byKey = new Map((chapterGroups.get(m.key) ?? []).map(c => [c.key, c.chapter]));
    let flags = previous.viewerFlags ?? previous.viewer ?? 0;
    if (m.readerMode && readerModeFromFlags(flags) !== m.readerMode) flags = flags & ~7 | modes[m.readerMode];
    const thumbnailUrl = /^https?:\/\//.test(m.manga.coverUrl) && !m.manga.coverUrl.includes('/api/v1/manga/') ? m.manga.coverUrl : previous.thumbnailUrl ?? '';
    backup.manga.push({
      source, url: nativeUrl(m.manga.sourceId, m.manga.id, m.manga.url), title: m.manga.title, artist: m.manga.artist ?? '', author: m.manga.author ?? '',
      description: m.manga.description, genres: m.manga.genres, status: statusNumbers[m.manga.status], thumbnailUrl, dateAdded: entry?.addedAt ?? previous.dateAdded ?? 0,
      viewer: previous.viewer ?? 0, viewerFlags: flags, chapterFlags: previous.chapterFlags ?? 0, chapters,
      categories: entry ? libraryCategories(entry).flatMap(name => categoryOrders.has(name) ? [categoryOrders.get(name)!] : []) : [],
      history: (historyGroups.get(m.key) ?? []).map(h => {
        const c = byKey.get(h.key);
        const id = h.key.slice(m.key.length + 2);
        return { url: c?.url || (dex ? `/chapter/${c?.id ?? id}` : c?.id ?? id), lastRead: h.updatedAt, readDuration: h.readDuration ?? 0 };
      }),
      tracking: previous.tracking ?? [], favorite: !!entry, updateStrategy: previous.updateStrategy ?? 0, favoriteModifiedAt: previous.favoriteModifiedAt ?? 0,
      excludedScanlators: previous.excludedScanlators ?? [], notes: m.notes ?? previous.notes ?? '', initialized: true, memo: previous.memo ?? '', nextUpdate: previous.nextUpdate ?? 0,
    });
    sourceNames.set(source.toString(), m.manga.sourceName ?? getSource(m.manga.sourceId)?.name ?? sourceNames.get(source.toString()) ?? `Source ${source}`);
  }
  if (!backup.manga.length) throw new Error('Add titles to your library before exporting a Mihon backup');
  backup.sources = [...new Set(backup.manga.map(m => m.source.toString()))].map(id => ({ sourceId: BigInt(id), name: sourceNames.get(id)! }));
  const settings = loadSettings();
  const sortNames = { title: 'ALPHABETICAL', read: 'LAST_READ', updated: 'LAST_MANGA_UPDATE', unread: 'UNREAD_COUNT', chapters: 'TOTAL_CHAPTERS', latest: 'LATEST_CHAPTER', fetched: 'CHAPTER_FETCH_DATE', added: 'DATE_ADDED', random: 'RANDOM' };
  const currentPreferences: ParsedPreference[] = [
    { key: 'library_sorting_mode', type: 'eu.kanade.tachiyomi.data.backup.models.StringPreferenceValue', value: `${sortNames[settings.librarySort]},${settings.librarySortDirection.toUpperCase()}`, rawValue: '' },
    { key: 'pref_default_viewer_key', type: 'eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue', value: modes[settings.readerMode], rawValue: '' },
  ];
  backup.preferences = [...backup.preferences.filter(p => !currentPreferences.some(current => current.key === p.key)), ...currentPreferences];
  const bytes = gzipSync(encodeTachibk(backup));
  return { file: new Blob([blobPart(bytes)], { type: 'application/gzip' }), mangaCount: backup.manga.length, libraryCount: library.length };
}
