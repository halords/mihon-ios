import { getSource } from '../sources';
import {
  deleteDownload,
  getDownloadsForManga,
  patchChapterState,
  putDownload,
} from './db';

export const PAGES_CACHE = 'mihon-pages-v1';

export function pageCacheKey(chapterKeyValue: string, index: number): string {
  return `https://cache.mihon.local/${encodeURIComponent(chapterKeyValue)}/${index}`;
}

export async function downloadChapter(
  mangaKey: string,
  chapterKeyValue: string,
  sourceId: string,
  mangaId: string,
  chapterId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const source = getSource(sourceId);
  if (!source) throw new Error('Source not available in PWA yet');

  // The source API resolves pages using only the chapter ID.
  void mangaId;

  const pages = await source.getPageList(chapterId);
  const cache = await caches.open(PAGES_CACHE);

  for (const [i, page] of pages.entries()) {
    const url = page.imageUrl;
    let mime = 'application/octet-stream';
    let blob: Blob;

    if (url.startsWith('data:')) {
      const commaIndex = url.indexOf(',');
      if (commaIndex === -1) {
        throw new Error('Invalid data URI: missing comma');
      }

      const metadata = url.slice(5, commaIndex);
      const payload = url.slice(commaIndex + 1);
      mime = metadata.split(';')[0] || 'application/octet-stream';

      if (metadata.includes(';base64')) {
        const decoded = atob(payload);
        const bytes = new Uint8Array(decoded.length);

        for (let j = 0; j < decoded.length; j += 1) {
          bytes[j] = decoded.charCodeAt(j);
        }

        blob = new Blob([bytes], { type: mime });
      } else {
        const bytes = new TextEncoder().encode(decodeURIComponent(payload));
        blob = new Blob([bytes], { type: mime });
      }
    } else {
      const res = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!res.ok) {
        throw new Error(`Failed to fetch page ${i + 1}: HTTP ${res.status}`);
      }
      blob = await res.blob();
    }

    await cache.put(
      pageCacheKey(chapterKeyValue, i),
      new Response(blob, {
        headers: { 'Content-Type': blob.type || mime },
      }),
    );
    onProgress?.(i + 1, pages.length);
  }

  await putDownload({
    key: chapterKeyValue,
    mangaKey,
    pageCount: pages.length,
    downloadedAt: Date.now(),
  });
  await patchChapterState(chapterKeyValue, mangaKey, { downloaded: true });

  return pages.length;
}

export async function deleteChapterDownload(
  mangaKey: string,
  chapterKeyValue: string,
): Promise<void> {
  const cache = await caches.open(PAGES_CACHE);
  const keys = await cache.keys();
  const prefix = `https://cache.mihon.local/${encodeURIComponent(chapterKeyValue)}/`;

  for (const request of keys) {
    if (request.url.startsWith(prefix)) {
      await cache.delete(request);
    }
  }

  await deleteDownload(chapterKeyValue);
  await patchChapterState(chapterKeyValue, mangaKey, { downloaded: false });
}

export async function deleteMangaDownloads(mangaKey: string): Promise<void> {
  for (const record of await getDownloadsForManga(mangaKey)) {
    await deleteChapterDownload(mangaKey, record.key);
  }
}

export async function isChapterCached(
  chapterKeyValue: string,
  pageCount: number,
): Promise<boolean> {
  if (pageCount <= 0) return false;

  const cache = await caches.open(PAGES_CACHE);
  for (let i = 0; i < pageCount; i += 1) {
    if (!(await cache.match(pageCacheKey(chapterKeyValue, i)))) {
      return false;
    }
  }

  return true;
}

export async function resolveChapterPages(
  chapterKeyValue: string,
  fallbackUrls: string[],
): Promise<string[]> {
  const cache = await caches.open(PAGES_CACHE);
  const result: string[] = [];

  for (const [i, fallbackUrl] of fallbackUrls.entries()) {
    const hit = await cache.match(pageCacheKey(chapterKeyValue, i));
    if (hit) {
      const blob = await hit.blob();
      result.push(URL.createObjectURL(blob));
    } else {
      result.push(fallbackUrl);
    }
  }

  return result;
}

export function revokeBlobUrls(urls: string[]): void {
  for (const url of urls) {
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }
}

export async function clearPagesCache(): Promise<void> {
  await caches.delete(PAGES_CACHE);
}
