import { getDB, getDownloadJobs, getManga, getChapterMetas, isMangaDownloadRemoved, type DownloadJob } from './db';
import { chapterKey, splitMangaKey } from '../sources/Source';
import { downloadChapter, deleteChapterDownload, isChapterCached } from './downloads';
import { emitLibraryLive } from './libraryLive';

type QueueSnapshot = { jobs: DownloadJob[]; paused: boolean; offline: boolean };
let snapshot: QueueSnapshot = { jobs: [], paused: false, offline: false };
const listeners = new Set<() => void>();
let initialized: Promise<void> | undefined;
let pumping = false;
let pumpRequested = false;
let current: { key: string; controller: AbortController } | undefined;
let channel: BroadcastChannel | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const networkOffline = () => navigator.onLine === false;

/** DownloadJob plus the queue's automatic-retry bookkeeping. Kept off the
 * db.ts record type: jobs written before this feature simply lack the
 * fields, and other writers spread records without dropping them. */
export type DownloadJobRecord = DownloadJob & { attempts?: number; notBefore?: number };

const MAX_AUTO_RETRIES = 2;
/** Cooldowns before the 1st / 2nd automatic retry of a transiently failed
 * chapter. Rate-limited sources (e.g. Mangakakalot under bulk downloads)
 * get much longer cooldowns — retrying into a 429/503 after a few seconds
 * just re-trips the limit. Exported as mutable values so tests can
 * shorten them instead of waiting in real time. */
export const AUTO_RETRY_DELAYS_MS = { transient: [5000, 15000], rateLimit: [60000, 180000] };
/** Failures that retrying cannot fix; these fail immediately, as before. */
const NON_TRANSIENT_MESSAGES = ['Device storage is full', 'removed from your library', 'Add this title back to your library', 'no downloadable pages', 'too many pages', 'has no image URL'];
function isRateLimitMessage(message: string): boolean {
  return message.includes('HTTP 429') || message.includes('HTTP 503') || message.toLowerCase().includes('rate limit');
}
/** Cooldown before the next automatic retry, or undefined when the job
 * should be marked failed: a non-transient error, or retries exhausted. */
function autoRetryDelay(message: string, used: number): number | undefined {
  if (NON_TRANSIENT_MESSAGES.some(text => message.includes(text))) return undefined;
  if (used >= MAX_AUTO_RETRIES) return undefined;
  const delays = isRateLimitMessage(message) ? AUTO_RETRY_DELAYS_MS.rateLimit : AUTO_RETRY_DELAYS_MS.transient;
  return delays[used];
}

export function subscribeDownloads(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function getQueueSnapshot(): QueueSnapshot { return snapshot; }
async function refresh(broadcast = true): Promise<void> {
  const db = await getDB();
  const [jobs, paused] = await Promise.all([getDownloadJobs(), db.get('metadata', 'downloads:paused')]);
  snapshot = { jobs, paused: paused?.value === true, offline: navigator.onLine === false };
  if (snapshot.paused) current?.controller.abort(new DOMException('Paused', 'AbortError'));
  if (current && !jobs.some(job => job.key === current!.key)) current.controller.abort(new DOMException('Removed', 'AbortError'));
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
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
  let wakeLock: WakeLockSentinel | undefined;
  try {
    // This runs inside the queue lock: no other tab can own these jobs.
    const db = await getDB();
    for (const job of await getDownloadJobs()) if (job.status === 'downloading' || job.status === 'paused' && !snapshot.paused) await db.put('downloadQueue', { ...job, status: 'queued' });
    if (navigator.wakeLock && !document.hidden) wakeLock = await navigator.wakeLock.request('screen').catch(() => undefined);
    while (!snapshot.paused && !networkOffline()) {
      await refresh(false);
      if (snapshot.paused || networkOffline()) break;
      const waiting = (await getDownloadJobs() as DownloadJobRecord[]).filter(j => j.status === 'queued');
      if (!waiting.length) break;
      const now = Date.now();
      const queued = waiting.filter(j => (j.notBefore ?? 0) <= now);
      if (!queued.length) {
        // Only auto-retry cooldowns remain: schedule a fallback pump and
        // exit to release the Web Lock and wake lock. Queue events can
        // pump sooner. The pump no longer notices raw IndexedDB edits
        // that bypass queue APIs — all real edit paths go through queue
        // APIs or BroadcastChannel.
        const dueAt = Math.min(...waiting.map(j => j.notBefore ?? 0));
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void pump();
        }, Math.max(0, dueAt - Date.now()));
        break;
      }
      // Chapters download oldest first within each title (chapter number
      // ascending), so a series is readable from the start while the rest
      // is still coming down. Titles keep the order they were queued in.
      const numbers = new Map<string, number>();
      for (const mangaKey of new Set(queued.map(j => j.mangaKey))) {
        for (const meta of await getChapterMetas(mangaKey)) numbers.set(meta.key, meta.chapter.number);
      }
      const titleSince = new Map<string, number>();
      for (const j of queued) titleSince.set(j.mangaKey, Math.min(titleSince.get(j.mangaKey) ?? Infinity, j.createdAt));
      queued.sort((a, b) => (titleSince.get(a.mangaKey)! - titleSince.get(b.mangaKey)!)
        || ((numbers.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (numbers.get(b.key) ?? Number.MAX_SAFE_INTEGER))
        || (a.createdAt - b.createdAt));
      const job = queued[0]!;
      const controller = new AbortController();
      current = { key: job.key, controller };
      const claim = db.transaction('downloadQueue', 'readwrite');
      const latest = await claim.store.get(job.key) as DownloadJobRecord | undefined;
      if (latest?.status === 'queued') {
        const claimed: DownloadJobRecord = { ...latest, status: 'downloading', error: undefined, notBefore: undefined, updatedAt: Date.now() };
        await claim.store.put(claimed);
      }
      await claim.done;
      if (latest?.status !== 'queued') { current = undefined; continue; }
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
        // Live library update: the title's downloaded count changed.
        emitLibraryLive({ type: 'counts-changed', mangaKey: job.mangaKey });
      } catch (error) {
        const latest = await db.get('downloadQueue', job.key) as DownloadJobRecord | undefined;
        if (latest) {
          let record: DownloadJobRecord;
          if (controller.signal.aborted) {
            record = { ...latest, status: snapshot.paused ? 'paused' : 'queued', error: undefined, updatedAt: Date.now() };
          } else {
            const message = error instanceof Error ? error.message : 'Download failed';
            const delay = autoRetryDelay(message, latest.attempts ?? 0);
            // Transient failures re-queue themselves with a cooldown
            // instead of dying on the first bad page: one poisoned page
            // fetch used to force a manual retry per chapter. The job
            // keeps its original createdAt, so the title/chapter
            // ordering above is unaffected when it runs again.
            record = delay === undefined
              ? { ...latest, status: 'failed', error: message, notBefore: undefined, updatedAt: Date.now() }
              : { ...latest, status: 'queued', attempts: (latest.attempts ?? 0) + 1, notBefore: Date.now() + delay, error: undefined, updatedAt: Date.now() };
          }
          await db.put('downloadQueue', record);
        }
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
  if (await isMangaDownloadRemoved(mangaKey)) return 0;
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
    // A re-added job starts its automatic-retry budget fresh.
    const record: DownloadJobRecord = {
      key, mangaKey, sourceId, mangaId, chapterId, mangaTitle: manga?.manga.title ?? 'Manga', chapterName: meta.chapter.name,
      status: 'queued', done: existing?.done ?? 0, total: existing?.total ?? 0, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
      attempts: undefined, notBefore: undefined,
    };
    await db.put('downloadQueue', record);
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

export async function waitForDownloadsIdle(): Promise<void> {
  const started = Date.now();
  while (current) {
    if (Date.now() - started > 30000) throw new Error('The current download is still stopping. Try signing in again shortly.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export async function retryDownload(key: string): Promise<void> {
  await initDownloadQueue();
  const db = await getDB();
  const job = await db.get('downloadQueue', key) as DownloadJobRecord | undefined;
  // A manual retry also resets the automatic-retry budget and cooldown.
  if (job) {
    const record: DownloadJobRecord = { ...job, status: 'queued', error: undefined, attempts: undefined, notBefore: undefined };
    await db.put('downloadQueue', record);
  }
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
export async function cancelMangaDownloadJobs(mangaKey: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('downloadQueue', 'readwrite');
  for (const job of await tx.store.getAll()) {
    if (job.mangaKey !== mangaKey) continue;
    if (current?.key === job.key) current.controller.abort(new DOMException('Title removed', 'AbortError'));
    await tx.store.delete(job.key);
  }
  await tx.done;
  await refresh();
}
export async function clearDownloadQueue(): Promise<void> {
  await initDownloadQueue();
  const db = await getDB();
  const wasPaused = !!(await db.get('metadata', 'downloads:paused'))?.value;
  try {
    await setDownloadsPaused(true);
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    const jobs = await getDownloadJobs();
    if (!jobs.length) { await refresh(); return; }
    // Abort the in-flight download without awaiting it: waiting on its
    // promise here could hang the whole clear behind one wedged fetch.
    if (current) current.controller.abort(new DOMException('Queue cleared', 'AbortError'));
    // Remove every job row in a single transaction first, so the queue is
    // empty no matter what happens during page cleanup below.
    const tx = db.transaction('downloadQueue', 'readwrite');
    for (const job of jobs) await tx.store.delete(job.key);
    await tx.done;
    await refresh();
    // Partial pages are cleaned up per job, each isolated: one job whose
    // cache cleanup throws must not strand the rest (the old loop removed
    // jobs one at a time through removeDownloadJob, so the first failure
    // stopped the clear with most chapters still listed).
    for (const job of jobs) {
      try { await deleteChapterDownload(job.mangaKey, job.key); } catch { /* keep clearing the rest */ }
    }
    await refresh();
  } finally {
    // A clear must not strand later downloads in a paused queue with no
    // visible resume control: restore the state from before the clear
    // (same pattern connect() uses in account.ts when switching profiles).
    await setDownloadsPaused(wasPaused);
  }
}
