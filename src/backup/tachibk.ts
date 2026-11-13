import { chapterKey, mangaKey, type MangaStatus, type SChapter, type SManga } from '../sources/Source';
import { getSource } from '../sources';
import { coverArt } from '../sources/svgArt';
import { dispatchDataEvent, downloadRemovalKey, getCategories, getDB, libraryCategories, type CategoryRecord } from '../lib/db';
import { emitLibraryLive } from '../lib/libraryLive';
import { saveSettings, type ReaderMode } from '../lib/settings';
import { mihonLibrarySort } from '../lib/librarySort';
import { blobPart } from '../lib/bytes';
import { parseTachibk } from './parser';
import { gunzipIfNeeded } from './compression';
import { jsonSafe, type ParsedBackup, type ParsedManga } from './models';
import { syncNativeStore } from '../lib/syncStorage';

export { parseTachibk } from './parser';
export { gunzipIfNeeded } from './compression';
export type * from './models';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const MANGADEX_MIHON_ID = '2499283573021220255';
export function extractUuid(url: string): string | null { return UUID_RE.exec(url)?.[0]?.toLowerCase() ?? null; }
export function mapStatus(value: number): MangaStatus {
  return ({ 1: 'Ongoing', 2: 'Completed', 3: 'Licensed', 4: 'Publishing Finished', 5: 'Cancelled', 6: 'On Hold' } as const)[value] ?? 'Unknown';
}
export function readerModeFromFlags(flags: number): ReaderMode | undefined {
  const mode = flags & 7;
  return mode === 0 ? undefined : mode === 1 ? 'paged' : mode === 2 ? 'rtl' : 'vertical';
}

export function resolveBackupSource(manga: ParsedManga, sourceName?: string) {
  const originalId = manga.source.toString();
  const dex = originalId === MANGADEX_MIHON_ID || /^mangadex(?:\b|\s|\()/i.test(sourceName ?? '');
  const uuid = dex ? extractUuid(manga.url) : null;
  const sourceId = uuid ? 'mangadex' : originalId;
  return { sourceId, mangaId: uuid ?? manga.url, available: !!getSource(sourceId), dex: !!uuid };
}

export interface BackupSourceSummary { id: string; name: string; mangaCount: number; available: boolean }
export interface TachibkPreview {
  name: string; file: Blob; archiveId: string; backup: ParsedBackup;
  sources: BackupSourceSummary[]; mangaCount: number; libraryCount: number;
  chapterCount: number; readCount: number; bookmarkCount: number;
  historyCount: number; trackingCount: number;
}
export interface TachibkImportResult {
  mangaCount: number; libraryCount: number; chapterCount: number; categoryCount: number;
  historyCount: number; bookmarkCount: number; trackingCount: number;
  mangadexMatched: number; availableCount: number; unavailableCount: number; archiveId: string;
}
export interface RestoreOptions { restorePreferences?: boolean; onProgress?: (done: number, total: number) => void }

async function parseInWorker(raw: Uint8Array): Promise<ParsedBackup> {
  if (typeof Worker === 'undefined') return parseTachibk(await gunzipIfNeeded(raw));
  let worker: Worker;
  try { worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }); }
  catch { return parseTachibk(await gunzipIfNeeded(raw)); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Backup parsing timed out')); }, 120000);
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    worker.onmessage = (event: MessageEvent<{ backup?: ParsedBackup; error?: string }>) => {
      finish();
      if (event.data.backup) resolve(event.data.backup);
      else reject(new Error(event.data.error ?? 'Invalid backup'));
    };
    worker.onerror = event => { finish(); reject(new Error(event.message || 'Unable to read backup')); };
    worker.postMessage({ bytes: raw });
  });
}

export async function inspectTachibkFile(file: Blob): Promise<TachibkPreview> {
  // Judge the file by the bytes actually read, never by Blob.size: Android
  // file pickers (content:// providers, in-app WebViews) can report size 0
  // for a perfectly valid backup, which used to reject real backups with a
  // bogus "0 bytes" error before a single byte was read.
  const raw = new Uint8Array(await file.arrayBuffer());
  if (!raw.length) throw new Error('This backup is empty (0 bytes). Choose the original .tachibk file.');
  if (raw.length > 128 * 1024 * 1024) throw new Error('This backup exceeds the 128 MB file limit');
  const digest = await crypto.subtle.digest('SHA-256', blobPart(raw));
  const archiveId = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
  const backup = await parseInWorker(raw);
  const names = new Map(backup.sources.map(s => [s.sourceId.toString(), s.name]));
  const summary = new Map<string, BackupSourceSummary>();
  for (const m of backup.manga) {
    const id = m.source.toString();
    const name = names.get(id) ?? (id === '0' ? 'Local files' : `Source ${id}`);
    const entry = summary.get(id) ?? { id, name, mangaCount: 0, available: resolveBackupSource(m, name).available };
    entry.mangaCount++;
    summary.set(id, entry);
  }
  const chapters = backup.manga.flatMap(m => m.chapters);
  return {
    name: 'name' in file && typeof file.name === 'string' ? file.name : 'mihon-backup.tachibk',
    file, archiveId, backup, sources: [...summary.values()].sort((a, b) => b.mangaCount - a.mangaCount),
    mangaCount: backup.manga.length, libraryCount: backup.manga.filter(m => m.favorite).length,
    chapterCount: chapters.length, readCount: chapters.filter(c => c.read).length,
    bookmarkCount: chapters.filter(c => c.bookmark).length,
    historyCount: backup.manga.reduce((n, m) => n + m.history.length, 0),
    trackingCount: backup.manga.reduce((n, m) => n + m.tracking.length, 0),
  };
}

export async function restoreTachibk(preview: TachibkPreview, options: RestoreOptions = {}): Promise<TachibkImportResult> {
  const { backup } = preview;
  // File-backed Blobs cannot reliably be cloned into IndexedDB in WebKit.
  // Typed bytes retain the identical archive without depending on file handles.
  const archiveBytes = new Uint8Array(await preview.file.arrayBuffer());
  const names = new Map(backup.sources.map(s => [s.sourceId.toString(), s.name]));
  const existingCategories = await getCategories();
  const categories: CategoryRecord[] = backup.categories.filter(c => !!c.name.trim()).map(c => {
    const existing = existingCategories.find(e => e.name === c.name);
    return { id: existing?.id ?? `mihon-category:${c.id}:${c.name}`, name: c.name, order: Number(c.order), mihonId: c.id.toString(), flags: c.flags.toString() };
  });
  // Mihon's MangaBackupCreator writes category.order, NOT category.id.
  // Check order first even if it collides with another category's database ID.
  const byOrder = new Map(backup.categories.map(c => [c.order.toString(), c.name]));
  const byId = new Map(backup.categories.map(c => [c.id.toString(), c.name]));
  const result: TachibkImportResult = {
    mangaCount: backup.manga.length, libraryCount: preview.libraryCount, chapterCount: preview.chapterCount,
    categoryCount: categories.length, historyCount: 0, bookmarkCount: preview.bookmarkCount,
    trackingCount: preview.trackingCount, mangadexMatched: 0, availableCount: 0, unavailableCount: 0, archiveId: preview.archiveId,
  };
  const db = await getDB();
  // Read existing state once, up front. Chapter and history keys embed their
  // manga key, so no two backup titles touch the same record and these maps
  // stay valid across the per-title transactions below.
  const readTx = db.transaction(['chapterState', 'history'], 'readonly');
  const [oldStates, oldHistory] = await Promise.all([
    readTx.objectStore('chapterState').getAll(), readTx.objectStore('history').getAll(),
  ]);
  const states = new Map(oldStates.map(state => [state.key, state]));
  const histories = new Map(oldHistory.map(history => [history.key, history]));
  // Categories land first, in their own transaction, so library memberships
  // resolve while the restore is still running.
  const categoryTx = db.transaction(['categories'], 'readwrite');
  try {
    for (const category of categories) await categoryTx.objectStore('categories').put(category);
    await categoryTx.done;
  } catch (error) {
    try { categoryTx.abort(); } catch { /* already aborted */ }
    await categoryTx.done.catch(() => {});
    throw error;
  }
  // One transaction per title instead of a single transaction for the whole
  // backup. A 60k-chapter backup issues ~160k writes plus one sync journal
  // entry per write; as one transaction, nothing was durable until the very
  // end, a backgrounded or killed tab rolled the entire restore back to
  // zero, and sync upload could not start until everything had finished.
  // Per-title commits make progress permanent title by title, and
  // re-running an interrupted restore is safe: every merge is idempotent.
  // On failure only the in-flight title rolls back; earlier titles stay.
  let activeTx: { abort(): void; done: Promise<void> } | undefined;
  try {
    for (const [index, pm] of backup.manga.entries()) {
      const tx = db.transaction(['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'metadata'], 'readwrite');
      activeTx = tx;
      // Native requests bubble failures to tx.done. They avoid creating a
      // promise/success callback for every one of thousands of chapter writes.
      const chapterStore = syncNativeStore(tx.objectStore('chapterMeta'));
      const stateStore = syncNativeStore(tx.objectStore('chapterState'));
      const historyStore = syncNativeStore(tx.objectStore('history'));
      const sourceName = names.get(pm.source.toString()) ?? (pm.source === 0n ? 'Local files' : `Source ${pm.source}`);
      const { sourceId, mangaId, available, dex } = resolveBackupSource(pm, sourceName);
      if (dex) result.mangadexMatched++;
      if (available) result.availableCount++; else result.unavailableCount++;
      const key = mangaKey(sourceId, mangaId);
      const title = pm.title || pm.url;
      const manga: SManga = {
        id: mangaId, sourceId, sourceName, url: pm.url, title, author: pm.author, artist: pm.artist,
        status: mapStatus(pm.status), description: pm.description, genres: pm.genres,
        coverUrl: pm.thumbnailUrl || coverArt(title, pm.author, [...pm.url].reduce((n, c) => n + c.charCodeAt(0), 0) % 360),
      };
      const previous = await tx.objectStore('manga').get(key);
      await tx.objectStore('manga').put({
        ...previous, key, manga, sourceAvailable: available, updatedAt: Date.now(),
        readerMode: previous?.readerMode ?? readerModeFromFlags(pm.viewerFlags ?? pm.viewer),
        notes: previous?.notes ?? pm.notes,
        mihon: jsonSafe({ ...pm, chapters: undefined, history: undefined, sourceName }),
      });
      const chapterByUrl = new Map<string, { chapter: SChapter; key: string; lastPage: number }>();
      const backupReadAt = new Map<string, number>();
      const writtenStates = new Set<string>();
      for (const history of pm.history) backupReadAt.set(history.url, Math.max(history.lastRead, backupReadAt.get(history.url) ?? 0));
      for (const pc of pm.chapters) {
        const id = dex ? extractUuid(pc.url) ?? pc.url : pc.url;
        const cKey = chapterKey(sourceId, mangaId, id);
        const chapter: SChapter = {
          id, mangaId, url: pc.url, name: pc.name || `Chapter ${pc.chapterNumber}`, number: pc.chapterNumber,
          dateUpload: pc.dateUpload, dateFetch: pc.dateFetch, scanlator: pc.scanlator, sourceOrder: pc.sourceOrder, memo: pc.memo,
        };
        chapterByUrl.set(pc.url, { chapter, key: cKey, lastPage: pc.lastPageRead });
        chapterStore.put({ key: cKey, mangaKey: key, chapter });
        const old = states.get(cKey);
        const newer = (old?.lastReadAt ?? 0) > (backupReadAt.get(pc.url) ?? 0);
        const restoredState = {
          ...old, key: cKey, mangaKey: key,
          read: newer ? old!.read : pc.read || !!old?.read, bookmark: pc.bookmark || !!old?.bookmark,
          lastPage: newer ? old!.lastPage : Math.max(pc.lastPageRead, old?.lastPage ?? 0), downloaded: old?.downloaded ?? false,
          // Folded into this single write (the history pass used to re-put
          // every state just to bump this): the newest history read time
          // for this chapter's URL.
          lastReadAt: Math.max(old?.lastReadAt ?? 0, backupReadAt.get(pc.url) ?? 0),
        };
        states.set(cKey, restoredState);
        stateStore.put(restoredState);
        writtenStates.add(cKey);
      }
      if (pm.favorite) {
        await tx.objectStore('metadata').delete(downloadRemovalKey(key));
        const categoryNames = [...new Set(pm.categories.map(id => byOrder.get(id.toString()) ?? byId.get(id.toString())).filter((v): v is string => !!v))];
        const old = await tx.objectStore('library').get(key);
        const membership = [...new Set([...categoryNames, ...(old ? libraryCategories(old) : [])])];
        await tx.objectStore('library').put({
          key, category: membership[0] ?? 'Default', categories: membership.length ? membership : ['Default'],
          addedAt: old?.addedAt ?? (pm.dateAdded > 0 ? pm.dateAdded : pm.favoriteModifiedAt > 0 ? pm.favoriteModifiedAt * 1000 : Date.now()),
        });
      }
      for (const h of pm.history) {
        let pair = chapterByUrl.get(h.url);
        if (!pair) {
          const id = dex ? extractUuid(h.url) ?? h.url : h.url;
          const chapter: SChapter = { id, mangaId, name: 'Imported chapter', url: h.url, number: -1, dateUpload: 0 };
          pair = { chapter, key: chapterKey(sourceId, mangaId, id), lastPage: 0 };
          chapterStore.put({ key: pair.key, mangaKey: key, chapter });
        }
        const old = histories.get(pair.key);
        if (!old || h.lastRead > old.updatedAt) {
          const history = {
            key: pair.key, mangaKey: key, mangaTitle: title, coverUrl: manga.coverUrl,
            chapterName: pair.chapter.name, page: pair.lastPage, updatedAt: h.lastRead, readDuration: h.readDuration,
          };
          histories.set(pair.key, history);
          historyStore.put(history);
        }
        // States written in the chapter pass already carry the folded
        // lastReadAt. Only a pre-existing state for a history-only chapter
        // (not in this title's chapter list) still needs the bump here.
        const state = states.get(pair.key);
        if (state && !writtenStates.has(pair.key)) {
          const restoredState = { ...state, lastReadAt: Math.max(h.lastRead, state.lastReadAt ?? 0) };
          states.set(pair.key, restoredState);
          stateStore.put(restoredState);
          writtenStates.add(pair.key);
        }
        result.historyCount++;
      }
      await tx.done;
      options.onProgress?.(index + 1, backup.manga.length);
    }
    // Backup-level records land last, in their own transaction, so a
    // retained original archive always represents a completed restore.
    const finalTx = db.transaction(['metadata', 'archives'], 'readwrite');
    activeTx = finalTx;
    for (const [key, value] of Object.entries({
      'mihon:sources': backup.sources, 'mihon:preferences': backup.preferences,
      'mihon:source-preferences': backup.sourcePreferences, 'mihon:extension-stores': backup.extensionStores,
    })) await finalTx.objectStore('metadata').put({ key, value: jsonSafe(value) });
    await finalTx.objectStore('archives').put({
      id: preview.archiveId, name: preview.name, importedAt: Date.now(), bytes: archiveBytes,
      mangaCount: preview.mangaCount, chapterCount: preview.chapterCount,
    });
    await finalTx.done;
  } catch (error) {
    try { activeTx?.abort(); } catch { /* already aborted */ }
    await activeTx?.done.catch(() => {});
    throw error;
  }
  if (options.restorePreferences) {
    const viewer = backup.preferences.find(p => p.key === 'pref_default_viewer_key');
    const mode = viewer ? readerModeFromFlags(Number(viewer.value)) : undefined;
    if (mode) saveSettings({ readerMode: mode });
    const sort = mihonLibrarySort(backup.preferences.find(p => p.key === 'library_sorting_mode')?.value);
    if (sort) saveSettings(sort);
  }
  dispatchDataEvent();
  // Restored titles must replace the stale session snapshot.
  emitLibraryLive({ type: 'library-invalidated' });
  return result;
}

export async function importTachibkFile(file: Blob, options?: RestoreOptions): Promise<TachibkImportResult> {
  return restoreTachibk(await inspectTachibkFile(file), options);
}
