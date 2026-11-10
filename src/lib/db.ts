import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import { CATEGORIES, chapterKey, compareChapters, mangaKey } from '../sources/Source';
import type { SChapter, SManga } from '../sources/Source';
import type { ReaderMode, Settings } from './settings';
import { loadSettings, saveSettings } from './settings';
import { fromBase64, toBase64, blobPart } from './bytes';

export interface StoredManga {
  key: string;
  manga: SManga;
  sourceAvailable: boolean;
  updatedAt: number;
  mihon?: Record<string, unknown>;
  readerMode?: ReaderMode;
  notes?: string;
  migratedFrom?: string;
}

export interface ChapterMetaRecord {
  key: string;
  mangaKey: string;
  chapter: SChapter;
}

export interface ChapterStateRecord {
  key: string;
  mangaKey: string;
  read: boolean;
  lastPage: number;
  downloaded: boolean;
  bookmark?: boolean;
  lastReadAt?: number;
  pageOffset?: number;
}

export interface LibraryRecord {
  key: string;
  category: string;
  addedAt: number;
  categories?: string[];
}

export interface HistoryRecord {
  key: string;
  mangaKey: string;
  mangaTitle: string;
  coverUrl: string;
  chapterName: string;
  page: number;
  updatedAt: number;
  readDuration?: number;
}

export interface DownloadRecord {
  key: string;
  mangaKey: string;
  pageCount: number;
  downloadedAt: number;
  byteSize?: number;
  pages?: { width?: number; height?: number; mime?: string }[];
  cacheKey?: string;
}

export interface CategoryRecord {
  id: string;
  name: string;
  order: number;
  mihonId?: string;
  flags?: string;
}

export interface ArchiveRecord {
  id: string;
  name: string;
  importedAt: number;
  bytes: Blob;
  mangaCount: number;
  chapterCount: number;
}
export type StoredArchiveRecord = Omit<ArchiveRecord, 'bytes'> & { bytes: Blob | Uint8Array };

export interface MetadataRecord { key: string; value: unknown }

export interface DownloadJob {
  key: string;
  mangaKey: string;
  sourceId: string;
  mangaId: string;
  chapterId: string;
  mangaTitle: string;
  chapterName: string;
  status: 'queued' | 'downloading' | 'paused' | 'failed';
  done: number;
  total: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BackendBinding {
  key: string;
  server: string;
  mangaId: number;
}

export interface BackupData {
  version: 1 | 2;
  exportedAt: number;
  manga: StoredManga[];
  chapterMeta: ChapterMetaRecord[];
  chapterState: ChapterStateRecord[];
  library: LibraryRecord[];
  history: HistoryRecord[];
  downloads: DownloadRecord[];
  categories?: CategoryRecord[];
  archives?: (Omit<ArchiveRecord, 'bytes'> & { base64: string })[];
  metadata?: MetadataRecord[];
  settings?: Settings;
  plugins?: InstalledPluginRecord[];
  downloadsIncluded?: false;
}

export interface InstalledPluginRecord {
  id: string; // source id the plugin registers under (may be a Mihon numeric id)
  name: string;
  version: string;
  lang?: string;
  nsfw?: boolean;
  moduleUrl: string; // absolute URL the code was fetched from
  indexUrl: string; // extension index this plugin came from
  code: string; // the module source, stored on-device
  installedAt: number;
  updatedAt: number;
}

export interface MihonDB extends DBSchema {
  categories: { key: string; value: CategoryRecord };
  archives: { key: string; value: StoredArchiveRecord };
  metadata: { key: string; value: MetadataRecord };
  downloadQueue: { key: string; value: DownloadJob };
  backendBindings: { key: string; value: BackendBinding };
  plugins: {
    key: string;
    value: InstalledPluginRecord;
  };
  manga: {
    key: string;
    value: StoredManga;
  };
  chapterMeta: {
    key: string;
    value: ChapterMetaRecord;
    indexes: { 'by-manga': string };
  };
  chapterState: {
    key: string;
    value: ChapterStateRecord;
    indexes: { 'by-manga': string };
  };
  library: {
    key: string;
    value: LibraryRecord;
  };
  history: {
    key: string;
    value: HistoryRecord;
    indexes: { 'by-manga': string };
  };
  downloads: {
    key: string;
    value: DownloadRecord;
    indexes: { 'by-manga': string };
  };
}

let databasePromise: Promise<IDBPDatabase<MihonDB>> | undefined;

export async function getDB(): Promise<IDBPDatabase<MihonDB>> {
  if (!databasePromise) {
    databasePromise = openDB<MihonDB>('mihon-pwa', 4, {
      upgrade(db, oldVersion, _nextVersion, tx) {
        if (oldVersion < 1) {
          db.createObjectStore('manga', { keyPath: 'key' });

          const chapterMeta = db.createObjectStore('chapterMeta', {
            keyPath: 'key',
          });
          chapterMeta.createIndex('by-manga', 'mangaKey');

          const chapterState = db.createObjectStore('chapterState', {
            keyPath: 'key',
          });
          chapterState.createIndex('by-manga', 'mangaKey');

          db.createObjectStore('library', { keyPath: 'key' });
          db.createObjectStore('history', { keyPath: 'key' });

          const downloads = db.createObjectStore('downloads', {
            keyPath: 'key',
          });
          downloads.createIndex('by-manga', 'mangaKey');
        }

        if (oldVersion < 2) {
          db.createObjectStore('plugins', { keyPath: 'id' });
        }
        if (oldVersion < 3) {
          const categories = db.createObjectStore('categories', { keyPath: 'id' });
          CATEGORIES.forEach((name, order) => categories.put({ id: `category:${name}`, name, order }));
          db.createObjectStore('archives', { keyPath: 'id' });
          db.createObjectStore('metadata', { keyPath: 'key' });
          db.createObjectStore('downloadQueue', { keyPath: 'key' });
          db.createObjectStore('backendBindings', { keyPath: 'key' });
        }
        if (oldVersion < 4) tx.objectStore('history').createIndex('by-manga', 'mangaKey');
      },
      blocked() { dispatchDataEvent('mihon:database-blocked'); },
      blocking(_current, _next, event) {
        (event.target as IDBDatabase).close();
        databasePromise = undefined;
      },
    }).catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
  }

  return databasePromise;
}

export async function putManga(
  manga: SManga,
  sourceAvailable = true,
): Promise<string> {
  const db = await getDB();
  const key = mangaKey(manga.sourceId, manga.id);
  const tx = db.transaction('manga', 'readwrite');
  const previous = await tx.store.get(key);
  await tx.store.put({
    ...previous,
    key,
    manga: { ...previous?.manga, ...manga },
    sourceAvailable,
    updatedAt: Date.now(),
  });
  await tx.done;

  return key;
}

export async function getManga(
  key: string,
): Promise<StoredManga | undefined> {
  const db = await getDB();
  return db.get('manga', key);
}

export async function getAllManga(): Promise<StoredManga[]> {
  const db = await getDB();
  return db.getAll('manga');
}

export async function putChapterMetas(
  sourceId: string,
  mangaId: string,
  chapters: SChapter[],
): Promise<void> {
  const db = await getDB();
  const parentKey = mangaKey(sourceId, mangaId);
  const tx = db.transaction('chapterMeta', 'readwrite');

  for (const chapter of chapters) {
    const key = chapterKey(sourceId, mangaId, chapter.id);
    const previous = await tx.store.get(key);
    const defined = Object.fromEntries(Object.entries(chapter).filter(([, v]) => v !== undefined));
    await tx.store.put({ key, mangaKey: parentKey, chapter: {
      ...previous?.chapter, ...defined,
      dateFetch: chapter.dateFetch ?? previous?.chapter.dateFetch ?? Date.now(),
    } as SChapter });
  }
  await tx.done;
}

export async function getChapterMetas(
  mangaKey: string,
): Promise<ChapterMetaRecord[]> {
  const db = await getDB();
  const records = await db.getAllFromIndex(
    'chapterMeta',
    'by-manga',
    mangaKey,
  );

  return records.sort((a, b) => compareChapters(a.chapter, b.chapter));
}

export async function getChapterState(
  key: string,
): Promise<ChapterStateRecord | undefined> {
  const db = await getDB();
  return db.get('chapterState', key);
}

export async function getChapterStates(
  mangaKey: string,
): Promise<ChapterStateRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('chapterState', 'by-manga', mangaKey);
}

export async function patchChapterState(
  key: string,
  mangaKey: string,
  patch: Partial<
    Pick<ChapterStateRecord, 'read' | 'lastPage' | 'downloaded' | 'bookmark' | 'lastReadAt' | 'pageOffset'>
  >,
): Promise<ChapterStateRecord> {
  const db = await getDB();
  const tx = db.transaction('chapterState', 'readwrite');
  const existing = await tx.store.get(key);

  const record: ChapterStateRecord = {
    ...existing,
    key,
    mangaKey,
    read: patch.read ?? existing?.read ?? false,
    lastPage: patch.lastPage ?? existing?.lastPage ?? 0,
    downloaded: patch.downloaded ?? existing?.downloaded ?? false,
    bookmark: patch.bookmark ?? existing?.bookmark ?? false,
    lastReadAt: patch.lastReadAt ?? (patch.read !== undefined ? Date.now() : existing?.lastReadAt),
    pageOffset: patch.pageOffset ?? (patch.lastPage === 0 ? 0 : existing?.pageOffset),
  };

  await Promise.all([tx.store.put(record), tx.done]);
  dispatchDataEvent();
  return record;
}

export async function getHistoryForManga(mangaKey: string): Promise<HistoryRecord[]> {
  return (await (await getDB()).getAllFromIndex('history', 'by-manga', mangaKey)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function dispatchDataEvent(name = 'mihon:data-changed'): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(name));
}

export function libraryCategories(entry: LibraryRecord): string[] {
  return entry.categories?.length ? entry.categories : [entry.category || 'Default'];
}

export async function getLibrary(): Promise<LibraryRecord[]> {
  const db = await getDB();
  const entries = await db.getAll('library');
  return entries.map(entry => ({ ...entry, categories: libraryCategories(entry) }));
}

export async function getLibraryEntry(
  key: string,
): Promise<LibraryRecord | undefined> {
  const db = await getDB();
  return db.get('library', key);
}

export async function addToLibrary(
  key: string,
  category: string | string[],
  addedAt?: number,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('library', 'readwrite');
  const existing = await tx.store.get(key);

  const categories = [...new Set(Array.isArray(category) ? category : [category])];
  await Promise.all([
    tx.store.put({
      key,
      category: categories[0] ?? 'Default',
      categories: categories.length ? categories : ['Default'],
      addedAt: existing?.addedAt ?? addedAt ?? Date.now(),
    }),
    tx.done,
  ]);
  dispatchDataEvent();
}

export async function removeFromLibrary(key: string): Promise<void> {
  const db = await getDB();
  await db.delete('library', key);
  dispatchDataEvent();
}

export async function setLibraryCategory(
  key: string,
  category: string | string[],
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('library', 'readwrite');
  const existing = await tx.store.get(key);

  if (existing) {
    const categories = [...new Set(Array.isArray(category) ? category : [category])];
    await Promise.all([
      tx.store.put({ ...existing, category: categories[0] ?? 'Default', categories: categories.length ? categories : ['Default'] }),
      tx.done,
    ]);
  } else {
    await tx.done;
  }
  dispatchDataEvent();
}

export async function getCategories(): Promise<CategoryRecord[]> {
  const db = await getDB();
  const [categories, library] = await Promise.all([db.getAll('categories'), getLibrary()]);
  const names = new Set(categories.map(c => c.name));
  for (const entry of library) for (const name of libraryCategories(entry)) {
    if (!names.has(name)) {
      categories.push({ id: `category:${name}`, name, order: categories.length });
      names.add(name);
    }
  }
  return categories.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export async function saveCategory(category: CategoryRecord): Promise<void> {
  const name = category.name.trim();
  if (!name) throw new Error('Enter a category name');
  const db = await getDB();
  const tx = db.transaction(['categories', 'library'], 'readwrite');
  const all = await tx.objectStore('categories').getAll();
  if (all.some(c => c.id !== category.id && c.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error('This category already exists');
  }
  const previous = all.find(c => c.id === category.id);
  const library = await tx.objectStore('library').getAll();
  if (previous && previous.name !== name) {
    for (const entry of library) {
      const categories = libraryCategories(entry).map(c => c === previous.name ? name : c);
      await tx.objectStore('library').put({ ...entry, category: categories[0]!, categories });
    }
  }
  await tx.objectStore('categories').put({ ...category, name });
  await tx.done;
  dispatchDataEvent();
}

export async function deleteCategory(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['categories', 'library'], 'readwrite');
  const category = await tx.objectStore('categories').get(id);
  if (category) {
    const library = await tx.objectStore('library').getAll();
    for (const entry of library) {
      const categories = libraryCategories(entry).filter(c => c !== category.name);
      await tx.objectStore('library').put({ ...entry, category: categories[0] ?? 'Default', categories: categories.length ? categories : ['Default'] });
    }
    await tx.objectStore('categories').delete(id);
  }
  await tx.done;
  dispatchDataEvent();
}

export async function saveReadingProgress(history: HistoryRecord, read: boolean, pageOffset = 0): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['chapterState', 'history'], 'readwrite');
  const state = await tx.objectStore('chapterState').get(history.key);
  const previous = await tx.objectStore('history').get(history.key);
  await tx.objectStore('chapterState').put({
    key: history.key, mangaKey: history.mangaKey, read: false, downloaded: false,
    ...state, lastPage: history.page, pageOffset, lastReadAt: history.updatedAt,
    ...(read ? { read: true } : {}),
  });
  await tx.objectStore('history').put({ ...history, readDuration: (previous?.readDuration ?? 0) + (history.readDuration ?? 0) });
  await tx.done;
}

export async function getAllDownloads(): Promise<DownloadRecord[]> { return (await getDB()).getAll('downloads'); }
export async function getArchives(): Promise<ArchiveRecord[]> {
  return (await (await getDB()).getAll('archives')).map(record => ({
    ...record, bytes: record.bytes instanceof Blob ? record.bytes : new Blob([blobPart(record.bytes)]),
  }));
}
export async function getDownloadJobs(): Promise<DownloadJob[]> {
  return (await (await getDB()).getAll('downloadQueue')).sort((a, b) => a.createdAt - b.createdAt);
}

export async function patchManga(key: string, patch: Partial<Pick<StoredManga, 'readerMode' | 'notes'>>): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('manga', 'readwrite');
  const manga = await tx.store.get(key);
  if (manga) await tx.store.put({ ...manga, ...patch });
  await tx.done;
}

export async function getHistory(): Promise<HistoryRecord[]> {
  const db = await getDB();
  const records = await db.getAll('history');
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putHistory(
  rec: Omit<HistoryRecord, 'key'> & { key: string },
): Promise<void> {
  const db = await getDB();
  await db.put('history', rec);
}

export async function clearHistory(): Promise<void> {
  const db = await getDB();
  await db.clear('history');
}

export async function getDownload(
  key: string,
): Promise<DownloadRecord | undefined> {
  const db = await getDB();
  return db.get('downloads', key);
}

export async function getDownloadsForManga(
  mangaKey: string,
): Promise<DownloadRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('downloads', 'by-manga', mangaKey);
}

export async function putDownload(rec: DownloadRecord): Promise<void> {
  const db = await getDB();
  await db.put('downloads', rec);
}

export async function deleteDownload(key: string): Promise<void> {
  const db = await getDB();
  await db.delete('downloads', key);
}

export async function deleteMangaData(mangaKey: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(
    ['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'downloads'],
    'readwrite',
  );

  const [metaKeys, stateKeys, downloadKeys, history] = await Promise.all([
    tx.objectStore('chapterMeta').index('by-manga').getAllKeys(mangaKey),
    tx.objectStore('chapterState').index('by-manga').getAllKeys(mangaKey),
    tx.objectStore('downloads').index('by-manga').getAllKeys(mangaKey),
    tx.objectStore('history').getAll(),
  ]);

  await Promise.all([
    tx.objectStore('manga').delete(mangaKey),
    tx.objectStore('library').delete(mangaKey),
    ...metaKeys.map((key) => tx.objectStore('chapterMeta').delete(key)),
    ...stateKeys.map((key) => tx.objectStore('chapterState').delete(key)),
    ...downloadKeys.map((key) => tx.objectStore('downloads').delete(key)),
    ...history
      .filter((record) => record.mangaKey === mangaKey)
      .map((record) => tx.objectStore('history').delete(record.key)),
    tx.done,
  ]);
}

export async function getInstalledPlugins(): Promise<InstalledPluginRecord[]> {
  const db = await getDB();
  return db.getAll('plugins');
}

export async function putInstalledPlugin(
  record: InstalledPluginRecord,
): Promise<void> {
  const db = await getDB();
  await db.put('plugins', record);
}

export async function deleteInstalledPlugin(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('plugins', id);
}

export async function exportData(): Promise<BackupData> {
  const db = await getDB();
  const tx = db.transaction(
    ['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'downloads', 'categories', 'metadata', 'archives', 'plugins'],
    'readonly',
  );

  const [manga, chapterMeta, chapterState, library, history, downloads, categories, metadata, originals, plugins] =
    await Promise.all([
      tx.objectStore('manga').getAll(),
      tx.objectStore('chapterMeta').getAll(),
      tx.objectStore('chapterState').getAll(),
      tx.objectStore('library').getAll(),
      tx.objectStore('history').getAll(),
      tx.objectStore('downloads').getAll(),
      tx.objectStore('categories').getAll(),
      tx.objectStore('metadata').getAll(),
      tx.objectStore('archives').getAll(),
      tx.objectStore('plugins').getAll(),
      tx.done,
    ]);

  return {
    version: 2,
    exportedAt: Date.now(),
    manga,
    chapterMeta,
    chapterState,
    library,
    history,
    downloads,
    categories,
    metadata,
    archives: await Promise.all(originals.map(async ({ bytes, ...archive }) => ({
      ...archive, base64: toBase64(bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes),
    }))),
    settings: loadSettings(),
    plugins,
    downloadsIncluded: false,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateBackupData(input: unknown): BackupData {
  if (!object(input) || ![1, 2].includes(Number(input.version))) throw new Error('Not a supported Mihon PWA backup');
  for (const name of ['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'downloads']) {
    if (!Array.isArray(input[name]) || input[name].some(r => !object(r) || typeof r.key !== 'string' || !r.key)) {
      throw new Error(`Invalid ${name} records in backup`);
    }
  }
  const data = input as unknown as BackupData;
  const mangaKeys = new Set(data.manga.map(record => record.key));
  for (const r of data.manga) {
    if (!object(r.manga) || typeof r.manga.id !== 'string' || typeof r.manga.sourceId !== 'string' ||
        r.key !== mangaKey(r.manga.sourceId, r.manga.id) || typeof r.manga.title !== 'string' ||
        typeof r.manga.coverUrl !== 'string' || !Array.isArray(r.manga.genres)) throw new Error('Invalid manga in backup');
  }
  for (const r of data.chapterMeta) {
    if (!mangaKeys.has(r.mangaKey) || !object(r.chapter) || typeof r.chapter.id !== 'string' ||
        r.key !== `${r.mangaKey}::${r.chapter.id}` || typeof r.chapter.name !== 'string' ||
        !Number.isFinite(r.chapter.number)) throw new Error('Invalid chapter in backup');
  }
  for (const r of [...data.chapterState, ...data.history, ...data.downloads]) {
    if (!mangaKeys.has(r.mangaKey) || !r.key.startsWith(`${r.mangaKey}::`)) throw new Error('Orphaned chapter record in backup');
  }
  for (const r of data.chapterState) {
    if (typeof r.read !== 'boolean' || !Number.isFinite(r.lastPage) || r.lastPage < 0) throw new Error('Invalid reading progress in backup');
  }
  for (const r of data.history) {
    if (!Number.isFinite(r.page) || r.page < 0 || !Number.isFinite(r.updatedAt)) throw new Error('Invalid history in backup');
  }
  for (const r of data.library) {
    if (!mangaKeys.has(r.key) || typeof r.category !== 'string' || !Number.isFinite(r.addedAt) ||
      (r.categories !== undefined && (!Array.isArray(r.categories) || r.categories.some(c => typeof c !== 'string')))) {
      throw new Error('Invalid library entry in backup');
    }
  }
  for (const r of data.downloads) if (!Number.isSafeInteger(r.pageCount) || r.pageCount < 1 || r.pageCount > 5000) throw new Error('Invalid download manifest');
  for (const name of ['categories', 'metadata', 'archives', 'plugins'] as const) {
    if (data[name] !== undefined && !Array.isArray(data[name])) throw new Error(`Invalid ${name} in backup`);
  }
  for (const c of data.categories ?? []) {
    if (!object(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || !c.name.trim() || !Number.isFinite(c.order)) throw new Error('Invalid category');
  }
  for (const m of data.metadata ?? []) if (!object(m) || typeof m.key !== 'string') throw new Error('Invalid backup metadata');
  for (const a of data.archives ?? []) {
    if (!object(a) || typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.base64 !== 'string') throw new Error('Invalid original backup archive');
  }
  return data;
}

// Validate and decode everything before opening a write transaction. A bad
// backup never leaves a half-restored library, and newer local reads survive.
export async function importData(input: unknown, restorePlugins = false): Promise<void> {
  const data = validateBackupData(input);
  const archives = (data.archives ?? []).map(({ base64, ...a }) => ({ ...a, bytes: fromBase64(base64) }));
  const { isChapterCached } = await import('./downloads');
  const usableDownloads = new Map<string, DownloadRecord>();
  const db = await getDB();
  for (const download of [...await db.getAll('downloads'), ...data.downloads]) {
    if (await isChapterCached(download.key, download.pageCount, download.cacheKey)) usableDownloads.set(download.key, download);
  }
  const tx = db.transaction(['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'downloads', 'categories', 'metadata', 'archives', 'plugins'], 'readwrite');
  try {
    for (const r of data.manga) {
      const existing = await tx.objectStore('manga').get(r.key);
      await tx.objectStore('manga').put(existing && existing.updatedAt > r.updatedAt ? existing : { ...existing, ...r });
    }
    for (const r of data.chapterMeta) await tx.objectStore('chapterMeta').put(r);
    for (const r of data.chapterState) {
      const old = await tx.objectStore('chapterState').get(r.key);
      const newer = (old?.lastReadAt ?? 0) > (r.lastReadAt ?? 0);
      await tx.objectStore('chapterState').put({
        ...r, ...old, read: newer ? old!.read : (r.lastReadAt ?? 0) > (old?.lastReadAt ?? 0) ? r.read : r.read || !!old?.read,
        bookmark: !!r.bookmark || !!old?.bookmark,
        lastPage: newer ? old!.lastPage : Math.max(r.lastPage, old?.lastPage ?? 0),
        pageOffset: newer ? old!.pageOffset : r.pageOffset ?? old?.pageOffset,
        lastReadAt: Math.max(r.lastReadAt ?? 0, old?.lastReadAt ?? 0),
        downloaded: usableDownloads.has(r.key),
      });
    }
    for (const r of data.library) {
      const old = await tx.objectStore('library').get(r.key);
      const categories = [...new Set([...libraryCategories(r), ...(old ? libraryCategories(old) : [])])];
      await tx.objectStore('library').put({ ...r, category: categories[0]!, categories, addedAt: old?.addedAt ?? r.addedAt });
    }
    for (const r of data.history) {
      const old = await tx.objectStore('history').get(r.key);
      if (!old || r.updatedAt > old.updatedAt) await tx.objectStore('history').put(r);
    }
    for (const r of await tx.objectStore('downloads').getAll()) if (!usableDownloads.has(r.key)) await tx.objectStore('downloads').delete(r.key);
    for (const r of usableDownloads.values()) await tx.objectStore('downloads').put(r);
    for (const r of data.categories ?? []) await tx.objectStore('categories').put(r);
    for (const r of data.metadata ?? []) await tx.objectStore('metadata').put(r);
    for (const r of archives) await tx.objectStore('archives').put(r);
    if (restorePlugins) {
      for (const r of data.plugins ?? []) {
        if (!r || typeof r.id !== 'string' || typeof r.code !== 'string') throw new Error('Invalid web extension');
        await tx.objectStore('plugins').put(r);
      }
    } else if (data.plugins?.length) {
      await tx.objectStore('metadata').put({ key: 'restored-web-extensions', value: data.plugins });
    }
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    await tx.done.catch(() => {});
    throw error;
  }
  if (data.settings) saveSettings(data.settings);
  dispatchDataEvent();
  dispatchDataEvent('mihon:downloads-changed');
}
