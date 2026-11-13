import { getCategories, getDB, getDownloadsForManga, type CategoryRecord, type ChapterMetaRecord, type ChapterStateRecord, type DownloadRecord, type HistoryRecord, type LibraryRecord, type StoredManga } from './db';
import { getSource } from '../sources';
import type { LibrarySortItem } from './librarySort';
import { subscribeLibraryLive, type LibraryLiveUpdate } from './libraryLive';

export interface LibraryItemData {
  entry: LibraryRecord; stored: StoredManga; chapters: ChapterMetaRecord[];
  unread: number; downloaded: number; bookmarked: boolean; lastRead: number;
  sort: LibrarySortItem;
}

export interface LibraryData {
  items: LibraryItemData[];
  state: Map<string, ChapterStateRecord>;
  downloaded: Set<string>;
  resume: HistoryRecord | undefined;
  categories: CategoryRecord[];
  // Retained (not just the derived resume) so live patches can recompute
  // the continue-reading card without re-reading the history store.
  history: HistoryRecord[];
}

function buildLibraryItem(entry: LibraryRecord, stored: StoredManga, chapters: ChapterMetaRecord[], state: Map<string, ChapterStateRecord>, downloaded: Set<string>, lastRead: number): LibraryItemData {
  const unread = chapters.filter(c => !state.get(c.key)?.read).length;
  return { entry, stored, chapters,
    unread,
    downloaded: chapters.filter(c => downloaded.has(c.key)).length,
    bookmarked: chapters.some(c => state.get(c.key)?.bookmark),
    lastRead,
    sort: { key: entry.key, title: stored.manga.title, added: entry.addedAt, read: lastRead,
      unread, chapters: chapters.length,
      updated: Math.max(0, ...chapters.map(c => c.chapter.dateFetch ?? 0)),
      latest: Math.max(0, ...chapters.map(c => c.chapter.dateUpload)),
      fetched: Math.max(0, ...chapters.map(c => c.chapter.dateFetch ?? 0)) } };
}

// Newest history entry that can actually resume: its title is in the
// library, the chapter is unread and in the saved list, and it is either
// downloaded or its source is available.
export function findResume(items: LibraryItemData[], state: Map<string, ChapterStateRecord>, downloaded: Set<string>, history: HistoryRecord[]): HistoryRecord | undefined {
  const byKey = new Map(items.map(i => [i.entry.key, i]));
  return [...history].sort((a, b) => b.updatedAt - a.updatedAt).find(h => {
    const item = byKey.get(h.mangaKey);
    return !!item && !state.get(h.key)?.read && item.chapters.some(c => c.key === h.key) &&
      (downloaded.has(h.key) || !!getSource(item.stored.manga.sourceId));
  });
}

export async function loadLibrary(): Promise<LibraryData> {
  const db = await getDB();
  const tx = db.transaction(['library', 'manga', 'chapterMeta', 'chapterState', 'history', 'downloads'], 'readonly');
  const [entries, mangas, metas, states, history, downloads] = await Promise.all([
    tx.objectStore('library').getAll(), tx.objectStore('manga').getAll(), tx.objectStore('chapterMeta').getAll(),
    tx.objectStore('chapterState').getAll(), tx.objectStore('history').getAll(), tx.objectStore('downloads').getAll(),
  ]);
  await tx.done;
  const stored = new Map(mangas.map(m => [m.key, m]));
  const state = new Map(states.map(s => [s.key, s]));
  const downloaded = new Set(downloads.map(d => d.key));
  const grouped = new Map<string, typeof metas>();
  for (const meta of metas) { const list = grouped.get(meta.mangaKey) ?? []; list.push(meta); grouped.set(meta.mangaKey, list); }
  const lastRead = new Map<string, number>();
  for (const h of history) lastRead.set(h.mangaKey, Math.max(lastRead.get(h.mangaKey) ?? 0, h.updatedAt));
  const items = entries.flatMap(entry => {
    const manga = stored.get(entry.key);
    if (!manga) return [];
    const chapters = (grouped.get(entry.key) ?? []).filter(c => !c.chapter.external);
    return [buildLibraryItem(entry, manga, chapters, state, downloaded, lastRead.get(entry.key) ?? 0)];
  });
  return { items, state, downloaded, resume: findResume(items, state, downloaded, history), categories: await getCategories(), history };
}

// Targeted single-title load for the library-added live update: reads only
// this title's rows via the by-manga indexes instead of re-reading the
// whole library. Returns the raw state/download rows too, so the caller
// can merge them into the snapshot's shared maps without a second read.
export interface LibraryItemLoad { item: LibraryItemData; states: ChapterStateRecord[]; downloads: DownloadRecord[]; }
export async function loadLibraryItem(mangaKey: string): Promise<LibraryItemLoad | null> {
  const db = await getDB();
  const [entry, stored, metas, states, history] = await Promise.all([
    db.get('library', mangaKey), db.get('manga', mangaKey),
    db.getAllFromIndex('chapterMeta', 'by-manga', mangaKey),
    db.getAllFromIndex('chapterState', 'by-manga', mangaKey),
    db.getAllFromIndex('history', 'by-manga', mangaKey),
  ]);
  if (!entry || !stored) return null;
  const downloads = await getDownloadsForManga(mangaKey);
  const chapters = metas.filter(c => !c.chapter.external);
  const state = new Map(states.map(s => [s.key, s]));
  const downloaded = new Set(downloads.map(d => d.key));
  const lastRead = history.reduce((max, h) => Math.max(max, h.updatedAt), 0);
  const built = buildLibraryItem(entry, stored, chapters, state, downloaded, lastRead);
  // A book just added comes first under the default Last-read sort, even
  // though it has never been read: sort by its add time, while lastRead
  // stays honest (0) so the Started filter does not claim it was started.
  // Session-only — a full reload re-derives sort.read from real history.
  const item = { ...built, sort: { ...built.sort, read: Math.max(built.sort.read, entry.addedAt) } };
  return { item, states, downloads };
}

// Applies one live update to a snapshot. Returns the SAME reference when
// nothing changed, so callers can skip re-rendering. Patches recompute the
// affected title's counts from its chapters plus the shared state/download
// maps, so applying the same update twice is harmless (the reader emits
// progress repeatedly while a finished chapter stays open).
export async function applyLibraryLiveUpdate(snapshot: LibraryData, update: LibraryLiveUpdate): Promise<LibraryData> {
  switch (update.type) {
    case 'library-invalidated':
      return loadLibrary();
    case 'chapter-progress': {
      const item = snapshot.items.find(i => i.entry.key === update.mangaKey);
      if (!item) return snapshot;
      const history = [...snapshot.history.filter(h => h.key !== update.history.key), update.history];
      // The state/download maps are internal to the snapshot and replaced
      // wholesale on the next full reload, so they are mutated in place;
      // the returned snapshot object and items array are new references.
      if (update.read) {
        const prev = snapshot.state.get(update.chapterKey);
        snapshot.state.set(update.chapterKey, { key: update.chapterKey, mangaKey: update.mangaKey,
          downloaded: false, ...prev,
          read: true, lastPage: update.history.page, lastReadAt: update.history.updatedAt,
          ...(update.downloadedDeleted ? { downloaded: false } : {}) });
      }
      if (update.downloadedDeleted) snapshot.downloaded.delete(update.chapterKey);
      const lastRead = Math.max(item.lastRead, update.history.updatedAt);
      const nextItem = buildLibraryItem(item.entry, item.stored, item.chapters, snapshot.state, snapshot.downloaded, lastRead);
      const items = snapshot.items.map(i => i === item ? nextItem : i);
      return { ...snapshot, items, history, resume: findResume(items, snapshot.state, snapshot.downloaded, history) };
    }
    case 'library-added': {
      if (snapshot.items.some(i => i.entry.key === update.mangaKey)) return snapshot;
      const loaded = await loadLibraryItem(update.mangaKey);
      if (!loaded) return snapshot;
      // Merge this title's rows into the shared maps so later patches and
      // the resume computation see it. (A full reload rebuilds them.)
      for (const s of loaded.states) snapshot.state.set(s.key, s);
      for (const d of loaded.downloads) snapshot.downloaded.add(d.key);
      return { ...snapshot, items: [loaded.item, ...snapshot.items] };
    }
    case 'library-removed': {
      if (!snapshot.items.some(i => i.entry.key === update.mangaKey)) return snapshot;
      const items = snapshot.items.filter(i => i.entry.key !== update.mangaKey);
      return { ...snapshot, items, resume: findResume(items, snapshot.state, snapshot.downloaded, snapshot.history) };
    }
  }
}

// Session snapshot: the library view is assembled once per app load and
// kept in memory. Tab switches render it instantly — no re-read of the
// ~140k chapter/history records behind it. It is NOT reloaded by
// background sync: data changes from sync pulls do not touch this view.
// It DOES patch live for the user's own actions (see libraryLive.ts):
// reading progress — a chapter opened and loaded bumps its title to the
// top — and adding/removing a title. Merely opening a title's details
// page does not move it. The view also reloads fully after backup restore
// or an account/profile switch (including device-library adoption), an
// action taken on the Library page itself, a refresh tap, or a full app
// reload.
let librarySnapshot: LibraryData | null = null;
const snapshotListeners = new Set<() => void>();

export function getLibrarySnapshot(): LibraryData | null { return librarySnapshot; }
export function subscribeLibrarySnapshot(fn: () => void): () => void {
  snapshotListeners.add(fn);
  return () => { snapshotListeners.delete(fn); };
}
function notifyLibrarySnapshot(): void { for (const fn of [...snapshotListeners]) fn(); }
export function setLibrarySnapshot(data: LibraryData): void { librarySnapshot = data; notifyLibrarySnapshot(); }

// Registered at module scope so the snapshot stays fresh even while the
// Library tab is not mounted — the reader finishes chapters while the
// Library page is unmounted, and the next visit must already show the
// new counts. Patches run through a chain so concurrent updates (e.g.
// two quick add-to-library taps) each see the latest snapshot.
let liveChain = Promise.resolve();
subscribeLibraryLive(update => {
  liveChain = liveChain.then(async () => {
    if (!librarySnapshot) return;
    const next = await applyLibraryLiveUpdate(librarySnapshot, update);
    if (next === librarySnapshot) return;
    librarySnapshot = next;
    notifyLibrarySnapshot();
  }).catch(() => {});
});
