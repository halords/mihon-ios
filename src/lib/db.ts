import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import { chapterKey, mangaKey } from '../sources/Source';
import type { SChapter, SManga } from '../sources/Source';

export interface StoredManga {
  key: string;
  manga: SManga;
  sourceAvailable: boolean;
  updatedAt: number;
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
}

export interface LibraryRecord {
  key: string;
  category: string;
  addedAt: number;
}

export interface HistoryRecord {
  key: string;
  mangaKey: string;
  mangaTitle: string;
  coverUrl: string;
  chapterName: string;
  page: number;
  updatedAt: number;
}

export interface DownloadRecord {
  key: string;
  mangaKey: string;
  pageCount: number;
  downloadedAt: number;
}

export interface BackupData {
  version: 1;
  exportedAt: number;
  manga: StoredManga[];
  chapterMeta: ChapterMetaRecord[];
  chapterState: ChapterStateRecord[];
  library: LibraryRecord[];
  history: HistoryRecord[];
  downloads: DownloadRecord[];
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
    databasePromise = openDB<MihonDB>('mihon-pwa', 2, {
      upgrade(db, oldVersion) {
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

  await db.put('manga', {
    key,
    manga,
    sourceAvailable,
    updatedAt: Date.now(),
  });

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

  await Promise.all([
    ...chapters.map((chapter) =>
      tx.store.put({
        key: chapterKey(sourceId, mangaId, chapter.id),
        mangaKey: parentKey,
        chapter,
      }),
    ),
    tx.done,
  ]);
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

  return records.sort((a, b) => a.chapter.number - b.chapter.number);
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
    Pick<ChapterStateRecord, 'read' | 'lastPage' | 'downloaded'>
  >,
): Promise<ChapterStateRecord> {
  const db = await getDB();
  const tx = db.transaction('chapterState', 'readwrite');
  const existing = await tx.store.get(key);

  const record: ChapterStateRecord = {
    key,
    mangaKey,
    read: patch.read ?? existing?.read ?? false,
    lastPage: patch.lastPage ?? existing?.lastPage ?? 0,
    downloaded: patch.downloaded ?? existing?.downloaded ?? false,
  };

  await Promise.all([tx.store.put(record), tx.done]);
  return record;
}

export async function getLibrary(): Promise<LibraryRecord[]> {
  const db = await getDB();
  return db.getAll('library');
}

export async function getLibraryEntry(
  key: string,
): Promise<LibraryRecord | undefined> {
  const db = await getDB();
  return db.get('library', key);
}

export async function addToLibrary(
  key: string,
  category: string,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('library', 'readwrite');
  const existing = await tx.store.get(key);

  await Promise.all([
    tx.store.put({
      key,
      category,
      addedAt: existing?.addedAt ?? Date.now(),
    }),
    tx.done,
  ]);
}

export async function removeFromLibrary(key: string): Promise<void> {
  const db = await getDB();
  await db.delete('library', key);
}

export async function setLibraryCategory(
  key: string,
  category: string,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('library', 'readwrite');
  const existing = await tx.store.get(key);

  if (existing) {
    await Promise.all([
      tx.store.put({ ...existing, category }),
      tx.done,
    ]);
  } else {
    await tx.done;
  }
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
    ['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'downloads'],
    'readonly',
  );

  const [manga, chapterMeta, chapterState, library, history, downloads] =
    await Promise.all([
      tx.objectStore('manga').getAll(),
      tx.objectStore('chapterMeta').getAll(),
      tx.objectStore('chapterState').getAll(),
      tx.objectStore('library').getAll(),
      tx.objectStore('history').getAll(),
      tx.objectStore('downloads').getAll(),
      tx.done,
    ]);

  return {
    version: 1,
    exportedAt: Date.now(),
    manga,
    chapterMeta,
    chapterState,
    library,
    history,
    downloads,
  };
}

export async function importData(data: BackupData): Promise<void> {
  if (data.version !== 1) {
    throw new Error('Unsupported backup version');
  }

  const db = await getDB();
  const tx = db.transaction(
    ['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'downloads'],
    'readwrite',
  );

  await Promise.all([
    ...data.manga.map((record) => tx.objectStore('manga').put(record)),
    ...data.chapterMeta.map((record) =>
      tx.objectStore('chapterMeta').put(record),
    ),
    ...data.chapterState.map((record) =>
      tx.objectStore('chapterState').put(record),
    ),
    ...data.library.map((record) => tx.objectStore('library').put(record)),
    ...data.history.map((record) => tx.objectStore('history').put(record)),
    ...data.downloads.map((record) => tx.objectStore('downloads').put(record)),
    tx.done,
  ]);
}
