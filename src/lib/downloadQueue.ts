import { getDB, getDownloadJobs, getManga, getChapterMetas, type DownloadJob } from './db';
import { chapterKey, splitMangaKey } from '../sources/Source';
import { downloadChapter, deleteChapterDownload, isChapterCached } from './downloads';

type QueueSnapshot = { jobs: DownloadJob[]; paused: boolean; offline: boolean };
let snapshot: QueueSnapshot = { jobs: [], paused: false, offline: false };
const listeners = new Set<() => void>();
let initialized: Promise<void> | undefined;
let pumping = false;
let pumpRequested = false;
let current: { key: string; controller: AbortController } | undefined;
let channel: BroadcastChannel | undefined;
const networkOffline = () => navigator.onLine === false;

export function subscribeDownloads(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function getQueueSnapshot(): QueueSnapshot { return snapshot; }
async function refresh(broadcast = true): Promise<void> {
  const db = await getDB();
  const [jobs, paused] = await Promise.all([getDownloadJobs(), db.get('metadata', 'downloads:paused')]);
  snapshot = { jobs, paused: paused?.value === true, offline: navigator.onLine === false };
  if (snapshot.paused) current?.controller.abort(new DOMException('Paused', 'AbortError'));
  for (const fn of listeners) fn();
  if (broadcast) channel?.postMessage('changed');
}

export function initDownloadQueue(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    const db = await getDB();
    snapshot = { ...snapshot, paused: (await db.get('metadata', 'downloads:paused'))?.value === true };
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('mihon-download-queue');
      channel.onmessage = () => { void refresh(false).then(() => pump()); };
    }
    window.addEventListener('online', () => { void refresh(); void pump(); });
    window.addEventListener('offline', () => { current?.controller.abort(); void refresh(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refresh(); void pump(); } });
    await refresh();
    void pump();
  })().catch(error => { initialized = undefined; throw error; });
  return initialized;
}

async function processQueue(): Promise<void> {
  let wakeLock: WakeLockSentinel | undefined;
  try {
    // This runs inside the queue lock: no other tab can own these jobs.
    const db = await getDB();
    for (const job of await getDownloadJobs()) if (job.status === 'downloading' || job.status === 'paused' && !snapshot.paused) await db.put('downloadQueue', { ...job, status: 'queued' });
    if (navigator.wakeLock && !document.hidden) wakeLock = await navigator.wakeLock.request('screen').catch(() => undefined);
    while (!snapshot.paused && !networkOffline()) {
      await refresh(false);
      if (snapshot.paused || networkOffline()) break;
      const job = (await getDownloadJobs()).find(j => j.status === 'queued');
      if (!job) break;
      const controller = new AbortController();
      current = { key: job.key, controller };
      await db.put('downloadQueue', { ...job, status: 'downloading', error: undefined, updatedAt: Date.now() });
      await refresh();
      try {
        await downloadChapter(job.mangaKey, job.key, job.sourceId, job.mangaId, job.chapterId, async (done, total) => {
          const tx = db.transaction('downloadQueue', 'readwrite');
          const latest = await tx.store.get(job.key);
          if (latest?.status === 'downloading') await tx.store.put({ ...latest, done, total, updatedAt: Date.now() });
          await tx.done;
          await refresh();
        }, controller.signal);
        await db.delete('downloadQueue', job.key);
      } catch (error) {
        const latest = await db.get('downloadQueue', job.key);
        if (latest) await db.put('downloadQueue', {
          ...latest, status: controller.signal.aborted ? snapshot.paused ? 'paused' : 'queued' : 'failed',
          error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : 'Download failed', updatedAt: Date.now(),
        });
      } finally { current = undefined; await refresh(); }
    }
  } finally { await wakeLock?.release().catch(() => {}); }
}

async function pump(): Promise<void> {
  pumpRequested = true;
  if (pumping || snapshot.paused || networkOffline()) return;
  pumping = true;
  try {
    do {
      pumpRequested = false;
      if (navigator.locks) {
        await navigator.locks.request('mihon-download-queue', { ifAvailable: true }, async lock => { if (lock) await processQueue(); });
      } else await processQueue();
    } while (pumpRequested && !snapshot.paused && !networkOffline());
  } finally { pumping = false; }
}

export async function enqueueChapters(mangaKey: string, chapterIds: string[]): Promise<number> {
  await initDownloadQueue();
  const db = await getDB();
  const [sourceId, mangaId] = splitMangaKey(mangaKey);
  const [manga, metas] = await Promise.all([getManga(mangaKey), getChapterMetas(mangaKey)]);
  let added = 0;
  for (const chapterId of [...new Set(chapterIds)]) {
    const key = chapterKey(sourceId, mangaId, chapterId);
    const meta = metas.find(c => c.key === key);
    if (!meta || meta.chapter.external) continue;
    const downloaded = await db.get('downloads', key);
    if (downloaded && await isChapterCached(key, downloaded.pageCount)) continue;
    const existing = await db.get('downloadQueue', key);
    if (existing && existing.status !== 'failed') continue;
    await db.put('downloadQueue', {
      key, mangaKey, sourceId, mangaId, chapterId, mangaTitle: manga?.manga.title ?? 'Manga', chapterName: meta.chapter.name,
      status: 'queued', done: existing?.done ?? 0, total: existing?.total ?? 0, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
    });
    added++;
  }
  await refresh();
  void pump();
  return added;
}

export async function setDownloadsPaused(paused: boolean): Promise<void> {
  await initDownloadQueue();
  snapshot = { ...snapshot, paused };
  const db = await getDB();
  await db.put('metadata', { key: 'downloads:paused', value: paused });
  if (paused) current?.controller.abort(new DOMException('Paused', 'AbortError'));
  else for (const job of await getDownloadJobs()) if (job.status === 'paused') await db.put('downloadQueue', { ...job, status: 'queued' });
  await refresh();
  if (!paused) void pump();
}

export async function retryDownload(key: string): Promise<void> {
  await initDownloadQueue();
  const db = await getDB();
  const job = await db.get('downloadQueue', key);
  if (job) await db.put('downloadQueue', { ...job, status: 'queued', error: undefined });
  await refresh();
  void pump();
}
export async function removeDownloadJob(key: string): Promise<void> {
  const db = await getDB();
  const job = await db.get('downloadQueue', key);
  if (!job) return;
  if (current?.key === key) current.controller.abort(new DOMException('Removed', 'AbortError'));
  await db.delete('downloadQueue', key);
  await deleteChapterDownload(job.mangaKey, key);
  await refresh();
}
export async function clearDownloadQueue(): Promise<void> {
  await setDownloadsPaused(true);
  for (const job of await getDownloadJobs()) await removeDownloadJob(job.key);
  await refresh();
}
