import { getSource } from '../sources';
import { dispatchDataEvent, downloadRemovalKey, getChapterMetas, getChapterState, getDB, getDownload, getDownloadsForManga, isMangaDownloadRemoved, type DownloadRecord } from './db';
import { loadSettings } from './settings';
import { fetchImage } from './fetchJson';
import { blobPart } from './bytes';
import { imageDimensions } from './images';
import type { MangaPage } from '../sources/Source';

export const PAGES_CACHE = 'mihon-pages-v1';
// Page fetches get up to six attempts: sources/CDNs intermittently answer
// with HTML interstitials or error pages served as HTTP 200, and one bad
// page used to fail the whole chapter after ~1s of retries. The delays
// between attempts are:
const PAGE_FETCH_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const INVALID_IMAGE_MESSAGE = 'The source did not return a valid image';
const EMPTY_IMAGE_MESSAGE = 'The source returned an empty image';

/** Append a `_r=` cache-buster to the query part of a URL, keeping any
 * `#hash` suffix byte-identical (sourceImages.ts parses `#tiles=...`
 * from the hash for tiled images; corrupting it breaks decoding). */
function cacheBustUrl(url: string, attempt: number): string {
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}_r=${attempt}${hash}`;
}
const active = new Map<string, { controller: AbortController; promise: Promise<number> }>();
export function pageCacheKey(key: string, index: number): string {
  return `https://cache.mihon.local/${encodeURIComponent(key)}/${index}`;
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Download cancelled', 'AbortError');
}
function pageIdentity(url: string): string {
  try {
    const parsed = new URL(url, 'https://mihon.local');
    const original = parsed.searchParams.get('url');
    if (original) return pageIdentity(original);
    if (parsed.hostname.endsWith('mangadex.network') || parsed.hostname.endsWith('mangadex.org')) return parsed.pathname;
    return url;
  } catch { return url; }
}

async function pageHash(url: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', blobPart(new TextEncoder().encode(pageIdentity(url))));
  return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export async function isChapterCached(key: string, count: number, storageKey?: string): Promise<boolean> {
  if (!Number.isInteger(count) || count < 1 || count > 5000 || typeof caches === 'undefined') return false;
  const cache = await caches.open(PAGES_CACHE);
  const actualKey = storageKey ?? (await getDownload(key))?.cacheKey ?? key;
  for (let i = 0; i < count; i++) {
    const page = await cache.match(pageCacheKey(actualKey, i));
    if (!page || !(await page.blob()).size) return false;
  }
  return true;
}

export async function commitDownload(record: DownloadRecord): Promise<void> {
  if (!(await isChapterCached(record.key, record.pageCount, record.cacheKey))) throw new Error('Some downloaded pages are missing. Retry the download.');
  const db = await getDB();
  const tx = db.transaction(['downloads', 'chapterState', 'metadata'], 'readwrite');
  if (await tx.objectStore('metadata').get(downloadRemovalKey(record.mangaKey))) {
    tx.abort(); await tx.done.catch(() => {});
    throw new Error('This title was removed. Add it back to your library before downloading.');
  }
  const state = await tx.objectStore('chapterState').get(record.key);
  await tx.objectStore('downloads').put(record);
  await tx.objectStore('chapterState').put({ key: record.key, mangaKey: record.mangaKey, read: false, lastPage: 0, ...state, downloaded: true });
  await tx.done;
  dispatchDataEvent('mihon:downloads-changed');
}

// Page-fetch parallelism for chapter downloads. Full speed runs 5 pages
// at once; the Calm downloads setting drops it to 3 — fewer simultaneous
// fetch/decode/store round trips means a cooler phone at some speed cost
// (heat-reduction pass, 2026-11-11).
export function downloadConcurrency(calm: boolean): number { return calm ? 3 : 5; }

export async function downloadChapter(
  mangaKey: string, key: string, sourceId: string, mangaId: string, chapterId: string,
  onProgress?: (done: number, total: number) => void | Promise<void>, signal?: AbortSignal,
): Promise<number> {
  const running = active.get(key);
  if (running) return running.promise;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const promise = (async () => {
    if (await isMangaDownloadRemoved(mangaKey)) throw new Error('Add this title back to your library before downloading.');
    const existing = await getDownload(key);
    if (existing && await isChapterCached(key, existing.pageCount)) {
      await onProgress?.(existing.pageCount, existing.pageCount);
      return existing.pageCount;
    }
    if (typeof caches === 'undefined') throw new Error('Offline storage requires HTTPS or localhost. Open the installed app over HTTPS.');
    const source = getSource(sourceId);
    if (!source) throw new Error('Connect this source in More → Connections, or migrate this title to another source.');
    const chapter = (await getChapterMetas(mangaKey)).find(c => c.key === key);
    if (chapter?.chapter.external) throw new Error('Externally hosted chapters cannot be downloaded');
    checkAbort(controller.signal);
    const pages = await source.getPageList(chapterId, mangaId, controller.signal);
    if (!pages.length) throw new Error('This chapter has no downloadable pages');
    if (pages.length > 5000) throw new Error('This chapter has too many pages for one download');
    if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
    const cache = await caches.open(PAGES_CACHE);
    let bytes = 0;
    const dimensions: DownloadRecord['pages'] = new Array(pages.length);
    await onProgress?.(0, pages.length);
    // Pages run through a small parallel pool instead of strictly one at
    // a time (a full fetch+decode+store round trip per page made chapter
    // downloads far slower than a native reader). Results land by page
    // index, so the stored page order and record shape are unchanged;
    // progress reports pages completed, whichever order they finish in.
    let next = 0; let completed = 0; let failure: unknown;
    const fetchPage = async (index: number): Promise<void> => {
      const page = pages[index]!;
      checkAbort(controller.signal);
      if (typeof page.imageUrl !== 'string' || !page.imageUrl) throw new Error(`Page ${index + 1} has no image URL`);
      const identity = await pageHash(page.imageUrl);
      const hit = await cache.match(pageCacheKey(key, index));
      if (hit && hit.headers.get('X-Mihon-Page') === identity) {
        const blob = await hit.blob();
        bytes += blob.size;
        const width = Number(hit.headers.get('X-Mihon-Width')) || page.width;
        const height = Number(hit.headers.get('X-Mihon-Height')) || page.height;
        dimensions[index] = { width, height };
      } else {
        let blob: Blob | undefined;
        let retryUrl: string | undefined;
        for (let attempt = 0; attempt <= PAGE_FETCH_RETRY_DELAYS_MS.length; attempt++) {
          checkAbort(controller.signal);
          try { blob = await fetchImage(retryUrl ?? page.imageUrl, controller.signal); break; }
          catch (error) {
            if (controller.signal.aborted || attempt === PAGE_FETCH_RETRY_DELAYS_MS.length || navigator.onLine === false) throw error;
            // A non-image body (HTML interstitial / CDN error page served
            // with HTTP 200) is usually a poisoned cache entry or a
            // rate-limit page: bust the cache on the next attempt so the
            // CDN is forced to re-fetch the real image. The cache identity
            // above stays keyed to the original URL; only the fetch URL
            // changes.
            const message = error instanceof Error ? error.message : '';
            if (message.includes(INVALID_IMAGE_MESSAGE) || message.includes(EMPTY_IMAGE_MESSAGE)) retryUrl = cacheBustUrl(page.imageUrl, attempt + 1);
            await new Promise<void>(resolve => setTimeout(resolve, PAGE_FETCH_RETRY_DELAYS_MS[attempt]));
          }
        }
        checkAbort(controller.signal);
        if (!blob) throw new Error(`Unable to download page ${index + 1}`);
        // Decoding every page just to measure it is a major CPU cost
        // during bulk downloads (phones heat up noticeably); when the
        // source already supplied the page size, trust it and skip the
        // decode entirely.
        const size = typeof page.width === 'number' && page.width > 0 && typeof page.height === 'number' && page.height > 0
          ? { width: page.width, height: page.height }
          : await imageDimensions(blob, controller.signal);
        if (await isMangaDownloadRemoved(mangaKey)) throw new Error('This title was removed from your library.');
        dimensions[index] = { width: size.width ?? page.width, height: size.height ?? page.height };
        try {
          await cache.put(pageCacheKey(key, index), new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Mihon-Page': identity, 'X-Mihon-Width': String(size.width ?? page.width ?? ''), 'X-Mihon-Height': String(size.height ?? page.height ?? '') } }));
        } catch (error) {
          if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new Error('Device storage is full. Delete some downloads and retry. Your partial download is kept.');
          throw error;
        }
        bytes += blob.size;
      }
      if (await isMangaDownloadRemoved(mangaKey)) {
        await cache.delete(pageCacheKey(key, index));
        throw new Error('This title was removed from your library.');
      }
      completed++;
      await onProgress?.(completed, pages.length);
    };
    const worker = async (): Promise<void> => {
      while (!failure && !controller.signal.aborted) {
        const index = next++;
        if (index >= pages.length) return;
        try { await fetchPage(index); }
        catch (error) { failure ??= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(downloadConcurrency(loadSettings().calmDownloads), pages.length) }, () => worker()));
    if (failure) throw failure;
    checkAbort(controller.signal);
    await commitDownload({ key, mangaKey, pageCount: pages.length, byteSize: bytes, downloadedAt: Date.now(), pages: dimensions });
    return pages.length;
  })();
  active.set(key, { controller, promise });
  try { return await promise; }
  finally { signal?.removeEventListener('abort', abort); active.delete(key); }
}

// Deletes one chapter's cached pages by constructed URL — page URLs are
// deterministic (pageCacheKey), so there is no need to enumerate the whole
// cache. The old full-cache scan listed every cached page in the app
// (~27,000 entries at 271 chapters), which made each delete slow enough
// for iOS to suspend the app before the record removal committed — the
// chapter stayed checked after a manual delete, and the reader-exit
// auto-delete chain died mid-flight the same way.
async function deleteCachedChapterPages(storageKey: string, pageCount: number): Promise<void> {
  if (typeof caches === 'undefined' || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 5000) return;
  const cache = await caches.open(PAGES_CACHE);
  const urls = Array.from({ length: pageCount }, (_, i) => pageCacheKey(storageKey, i));
  for (let start = 0; start < urls.length; start += 24) {
    await Promise.all(urls.slice(start, start + 24).map(url => cache.delete(url)));
  }
}

export async function deleteChapterDownload(mangaKey: string, key: string): Promise<void> {
  const task = active.get(key);
  if (task) {
    task.controller.abort(new DOMException('Download removed', 'AbortError'));
    await task.promise.catch(() => {});
  }
  const downloaded = await getDownload(key);
  // Commit the record removal FIRST: the chapter stops showing as
  // downloaded even if the cache sweep below is interrupted (iOS
  // suspending the app mid-delete used to leave the record behind).
  // Pages orphaned by an interrupted sweep are inert without a record
  // (nothing reads them: getCachedPageList and isChapterCached both
  // require the record) and are overwritten by any later re-download.
  // A chapter with no record has no manifest to sweep by; its partial
  // pages (if any) are left as resume fuel for a later download.
  const db = await getDB();
  const tx = db.transaction(['downloads', 'chapterState'], 'readwrite');
  await tx.objectStore('downloads').delete(key);
  const state = await tx.objectStore('chapterState').get(key);
  if (state) await tx.objectStore('chapterState').put({ ...state, downloaded: false });
  else await tx.objectStore('chapterState').put({ key, mangaKey, read: false, lastPage: 0, downloaded: false });
  await tx.done;
  dispatchDataEvent('mihon:downloads-changed');
  if (downloaded) {
    try { await deleteCachedChapterPages(downloaded.cacheKey ?? key, downloaded.pageCount); }
    catch (error) { console.warn('Page sweep failed after the download record was removed', error); }
  }
}
/** Mihon-style cleanup: once a chapter has been read to the end, its
 * downloaded pages are deleted to free storage. Gated by the
 * deleteReadDownloads setting (on by default); reading progress and
 * history are kept, and the chapter can be downloaded again anytime. */
export async function maybeAutoDeleteReadChapter(mangaKey: string, key: string): Promise<boolean> {
  if (!loadSettings().deleteReadDownloads) return false;
  const state = await getChapterState(key);
  if (!state?.read || !state.downloaded) return false;
  if (!(await getDownload(key))) return false;
  await deleteChapterDownload(mangaKey, key);
  return true;
}

/** Startup safety net for the deferred auto-delete: the reader-exit path
 * only runs on a clean exit, so chapters finished in a session that ends
 * with the app killed or suspended (lock the phone, swipe the app away)
 * never get deleted. This sweep runs at boot and removes every
 * read + downloaded chapter while the setting is on. Returns the number
 * of chapters deleted. Runs after reconcileDownloads, so only chapters
 * with a valid download record are considered, and before the download
 * queue starts, so no download is active. */
export async function sweepAutoDeleteReadChapters(): Promise<number> {
  if (!loadSettings().deleteReadDownloads) return 0;
  const db = await getDB();
  const downloads = await db.getAll('downloads');
  if (!downloads.length) return 0;
  const states = new Map((await db.getAll('chapterState')).map(state => [state.key, state]));
  let deleted = 0;
  for (const record of downloads) {
    if (!states.get(record.key)?.read) continue;
    try { await deleteChapterDownload(record.mangaKey, record.key); deleted++; }
    catch { /* one stuck chapter must not block the rest */ }
  }
  return deleted;
}
export async function deleteMangaDownloads(mangaKey: string): Promise<void> {
  const tasks = [...active].filter(([key]) => key.startsWith(mangaKey + '::')).map(([, task]) => task);
  for (const task of tasks) task.controller.abort(new DOMException('Title downloads removed', 'AbortError'));
  await Promise.allSettled(tasks.map(task => task.promise));
  const downloads = await getDownloadsForManga(mangaKey);
  if (typeof caches !== 'undefined') {
    const cache = await caches.open(PAGES_CACHE);
    const namespaces = new Set(downloads.map(record => record.cacheKey).filter((key): key is string => !!key));
    const requests = (await cache.keys()).filter(request => {
      const url = new URL(request.url);
      if (url.origin !== 'https://cache.mihon.local') return false;
      const namespace = decodeURIComponent(url.pathname.split('/')[1] ?? '');
      return namespace.startsWith(mangaKey + '::') || namespaces.has(namespace);
    });
    // Include partial pages with no manifest and CBZ replacement namespaces.
    // Enumerate the cache once for the entire title, not once per chapter.
    for (let start = 0; start < requests.length; start += 24) {
      await Promise.all(requests.slice(start, start + 24).map(request => cache.delete(request)));
    }
  }
  const db = await getDB();
  const tx = db.transaction(['downloads', 'chapterState'], 'readwrite');
  for (const record of downloads) await tx.objectStore('downloads').delete(record.key);
  for (const state of await tx.objectStore('chapterState').index('by-manga').getAll(mangaKey)) {
    if (state.downloaded) await tx.objectStore('chapterState').put({ ...state, downloaded: false });
  }
  await tx.done;
  dispatchDataEvent('mihon:downloads-changed');
}

export async function getCachedPageList(key: string): Promise<MangaPage[] | null> {
  const download = await getDownload(key);
  if (!download || !await isChapterCached(key, download.pageCount, download.cacheKey)) return null;
  return Array.from({ length: download.pageCount }, (_, i) => ({
    imageUrl: '', cachedKey: pageCacheKey(download.cacheKey ?? key, i),
    width: download.pages?.[i]?.width, height: download.pages?.[i]?.height,
  }));
}

export function revokeBlobUrls(urls: string[]): void {
  for (const url of urls) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}
export async function clearPagesCache(): Promise<void> {
  for (const task of active.values()) task.controller.abort(new DOMException('Downloads cleared', 'AbortError'));
  await Promise.allSettled([...active.values()].map(t => t.promise));
  if (typeof caches !== 'undefined') await caches.delete(PAGES_CACHE);
  const db = await getDB();
  const tx = db.transaction(['downloads', 'chapterState'], 'readwrite');
  for (const state of await tx.objectStore('chapterState').getAll()) {
    if (state.downloaded) await tx.objectStore('chapterState').put({ ...state, downloaded: false });
  }
  await tx.objectStore('downloads').clear();
  await tx.done;
  dispatchDataEvent('mihon:downloads-changed');
}

export async function reconcileDownloads(): Promise<number> {
  await (await import('./libraryFiles')).resumeLibraryFileCleanup();
  const db = await getDB();
  const downloads = await db.getAll('downloads');
  const cache = typeof caches === 'undefined' ? undefined : await caches.open(PAGES_CACHE);
  const present = new Set((await cache?.keys() ?? []).map(request => request.url));
  const valid = new Set<string>();
  for (const download of downloads) {
    if (Number.isInteger(download.pageCount) && download.pageCount > 0 && download.pageCount <= 5000 && Array.from({ length: download.pageCount }, (_, i) => pageCacheKey(download.cacheKey ?? download.key, i)).every(key => present.has(key))) valid.add(download.key);
  }
  const tx = db.transaction(['downloads', 'chapterState'], 'readwrite');
  for (const download of downloads) if (!valid.has(download.key)) await tx.objectStore('downloads').delete(download.key);
  for (const state of await tx.objectStore('chapterState').getAll()) {
    if (state.downloaded !== valid.has(state.key)) await tx.objectStore('chapterState').put({ ...state, downloaded: valid.has(state.key) });
  }
  await tx.done;
  dispatchDataEvent('mihon:downloads-changed');
  return downloads.length - valid.size;
}
