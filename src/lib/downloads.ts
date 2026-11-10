import { getSource } from '../sources';
import { dispatchDataEvent, downloadRemovalKey, getChapterMetas, getDB, getDownload, getDownloadsForManga, isMangaDownloadRemoved, type DownloadRecord } from './db';
import { fetchImage } from './fetchJson';
import { blobPart } from './bytes';
import { imageDimensions } from './images';
import type { MangaPage } from '../sources/Source';

export const PAGES_CACHE = 'mihon-pages-v1';
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
    const dimensions: DownloadRecord['pages'] = [];
    await onProgress?.(0, pages.length);
    for (const [index, page] of pages.entries()) {
      checkAbort(controller.signal);
      if (typeof page.imageUrl !== 'string' || !page.imageUrl) throw new Error(`Page ${index + 1} has no image URL`);
      const identity = await pageHash(page.imageUrl);
      const hit = await cache.match(pageCacheKey(key, index));
      if (hit && hit.headers.get('X-Mihon-Page') === identity) {
        const blob = await hit.blob();
        bytes += blob.size;
        const width = Number(hit.headers.get('X-Mihon-Width')) || page.width;
        const height = Number(hit.headers.get('X-Mihon-Height')) || page.height;
        dimensions.push({ width, height });
      } else {
        let blob: Blob | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          checkAbort(controller.signal);
          try { blob = await fetchImage(page.imageUrl, controller.signal); break; }
          catch (error) {
            if (controller.signal.aborted || attempt === 2 || navigator.onLine === false) throw error;
            await new Promise<void>(resolve => setTimeout(resolve, 350 * (attempt + 1)));
          }
        }
        checkAbort(controller.signal);
        if (!blob) throw new Error(`Unable to download page ${index + 1}`);
        const size = await imageDimensions(blob, controller.signal);
        if (await isMangaDownloadRemoved(mangaKey)) throw new Error('This title was removed from your library.');
        dimensions.push({ width: size.width ?? page.width, height: size.height ?? page.height });
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
      await onProgress?.(index + 1, pages.length);
    }
    checkAbort(controller.signal);
    await commitDownload({ key, mangaKey, pageCount: pages.length, byteSize: bytes, downloadedAt: Date.now(), pages: dimensions });
    return pages.length;
  })();
  active.set(key, { controller, promise });
  try { return await promise; }
  finally { signal?.removeEventListener('abort', abort); active.delete(key); }
}

export async function deleteChapterDownload(mangaKey: string, key: string): Promise<void> {
  const task = active.get(key);
  if (task) {
    task.controller.abort(new DOMException('Download removed', 'AbortError'));
    await task.promise.catch(() => {});
  }
  if (typeof caches !== 'undefined') {
    const cache = await caches.open(PAGES_CACHE);
    const downloaded = await getDownload(key);
    const prefixes = [key, downloaded?.cacheKey].filter((value): value is string => !!value).map(value => `https://cache.mihon.local/${encodeURIComponent(value)}/`);
    for (const request of await cache.keys()) if (prefixes.some(prefix => request.url.startsWith(prefix))) await cache.delete(request);
  }
  const db = await getDB();
  const tx = db.transaction(['downloads', 'chapterState'], 'readwrite');
  await tx.objectStore('downloads').delete(key);
  const state = await tx.objectStore('chapterState').get(key);
  if (state) await tx.objectStore('chapterState').put({ ...state, downloaded: false });
  else await tx.objectStore('chapterState').put({ key, mangaKey, read: false, lastPage: 0, downloaded: false });
  await tx.done;
  dispatchDataEvent('mihon:downloads-changed');
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

export async function getCachedChapterPages(key: string): Promise<string[] | null> {
  const download = await getDownload(key);
  if (!download || typeof caches === 'undefined') return null;
  const cache = await caches.open(PAGES_CACHE);
  const urls: string[] = [];
  try {
    for (let i = 0; i < download.pageCount; i++) {
      const response = await cache.match(pageCacheKey(download.cacheKey ?? key, i));
      if (!response) { revokeBlobUrls(urls); return null; }
      const blob = await response.blob();
      if (!blob.size) { revokeBlobUrls(urls); return null; }
      urls.push(URL.createObjectURL(blob));
    }
    return urls.length ? urls : null;
  } catch (error) { revokeBlobUrls(urls); throw error; }
}

export async function getCachedPageList(key: string): Promise<MangaPage[] | null> {
  const download = await getDownload(key);
  if (!download || !await isChapterCached(key, download.pageCount, download.cacheKey)) return null;
  return Array.from({ length: download.pageCount }, (_, i) => ({
    imageUrl: '', cachedKey: pageCacheKey(download.cacheKey ?? key, i),
    width: download.pages?.[i]?.width, height: download.pages?.[i]?.height,
  }));
}

export async function resolveChapterPages(key: string, fallbackUrls: string[]): Promise<string[]> {
  const cached = await getCachedChapterPages(key);
  return cached ?? fallbackUrls;
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
