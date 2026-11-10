import { unzip, zip, strToU8 } from 'fflate';
import { downloadRemovalKey, getChapterMetas, getManga, getDownload, getDB, libraryCategories, dispatchDataEvent } from './db';
import { isChapterCached, PAGES_CACHE, pageCacheKey } from './downloads';
import { blobPart } from './bytes';
import { chapterKey, mangaKey, splitMangaKey, type SChapter, type SManga } from '../sources/Source';
import { coverArt } from '../sources/svgArt';
import { saveFile } from './files';
import { imageDimensions, imageMime } from './images';

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif|svg)$/i;
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml' };
function readZip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  let total = 0;
  return new Promise((resolve, reject) => unzip(bytes, { filter: file => {
    if (!IMAGE_EXT.test(file.name) || /(?:^|\/)__MACOSX\//.test(file.name)) return false;
    total += file.originalSize;
    return total <= 512 * 1024 * 1024;
  } }, (error, files) => {
    if (error) reject(new Error('This file is not a valid CBZ/ZIP archive'));
    else if (total > 512 * 1024 * 1024) reject(new Error('The uncompressed chapter exceeds 512 MB'));
    else resolve(files);
  }));
}
function makeZip(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, { level: 0 }, (error, output) => error ? reject(error) : resolve(output)));
}
export async function importCbz(file: File, title: string, targetKey?: string): Promise<{ mangaKey: string; pageCount: number; chapterName: string }> {
  if (!file.size) throw new Error(`${file.name} is empty`);
  if (typeof caches === 'undefined') throw new Error('Offline chapter imports require HTTPS or localhost');
  if (file.size > 256 * 1024 * 1024) throw new Error('Import CBZ files smaller than 256 MB');
  const data = new Uint8Array(await file.arrayBuffer());
  const files = await readZip(data);
  const names = Object.keys(files).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!names.length) throw new Error('No supported image pages were found in this archive');
  if (names.length > 5000) throw new Error('This chapter has too many pages');
  const chapterName = file.name.replace(/\.(?:cbz|zip)$/i, '');
  const seriesTitle = title.trim() || chapterName;
  const key = targetKey ?? mangaKey('local', encodeURIComponent(seriesTitle.toLowerCase()));
  const [sourceId, mangaId] = splitMangaKey(key);
  const stored = await getManga(key);
  const number = Number(/(?:chapter|ch\.?|#)\s*(\d+(?:\.\d+)?)/i.exec(chapterName)?.[1] ?? /(?:^|[\s._-])(\d+(?:\.\d+)?)$/.exec(chapterName)?.[1] ?? '-1');
  const metas = await getChapterMetas(key);
  const byName = metas.filter(c => c.chapter.name === chapterName);
  const byNumber = number >= 0 ? metas.filter(c => c.chapter.number === number) : [];
  if (byName.length > 1 || !byName.length && byNumber.length > 1) throw new Error('This chapter matches several editions. Rename the CBZ to the exact saved chapter name.');
  const existing = byName[0] ?? byNumber[0];
  const digest = await crypto.subtle.digest('SHA-256', blobPart(data));
  const id = existing?.chapter.id ?? `cbz:${[...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  const cKey = chapterKey(sourceId, mangaId, id);
  const cache = await caches.open(PAGES_CACHE);
  const stagingKey = `${cKey}::cbz-staging:${crypto.randomUUID()}`;
  const previousDownload = await getDownload(cKey);
  let committed = false;
  let byteSize = 0;
  const pages: { width?: number; height?: number; mime?: string }[] = [];
  try {
    for (const [i, name] of names.entries()) {
      const bytes = files[name]!;
      if (!bytes.length) throw new Error(`Page ${i + 1} is empty`);
      const mime = imageMime(bytes);
      if (!mime) throw new Error(`Page ${i + 1} is not a supported image`);
      const blob = new Blob([blobPart(bytes)], { type: mime });
      pages.push({ ...await imageDimensions(blob), mime });
      await cache.put(pageCacheKey(stagingKey, i), new Response(blob, { headers: { 'Content-Type': mime } }));
      byteSize += bytes.length;
    }
    // The download manifest swaps to a fresh cache namespace atomically.
    // A failed replacement cannot overwrite the previous chapter's pages.
    const manga: SManga = stored?.manga ?? { id: mangaId, sourceId, sourceName: 'Local files', title: seriesTitle, status: 'Unknown', description: '', genres: [], coverUrl: coverArt(seriesTitle, 'Local files', 235) };
    const chapter: SChapter = { ...existing?.chapter, id, mangaId, name: existing?.chapter.name ?? chapterName, number: existing?.chapter.number ?? number, dateUpload: existing?.chapter.dateUpload ?? Date.now() };
    const db = await getDB();
    if (!await isChapterCached(cKey, names.length, stagingKey)) throw new Error('Some imported pages could not be saved');
    const tx = db.transaction(['manga', 'chapterMeta', 'library', 'downloads', 'chapterState', 'metadata'], 'readwrite');
    await tx.objectStore('metadata').delete(downloadRemovalKey(key));
    await tx.objectStore('manga').put({ ...stored, key, manga, sourceAvailable: false, updatedAt: Date.now() });
    await tx.objectStore('chapterMeta').put({ key: cKey, mangaKey: key, chapter });
    const entry = await tx.objectStore('library').get(key);
    const categories = entry ? libraryCategories(entry) : ['Default'];
    await tx.objectStore('library').put({ key, category: categories[0]!, categories, addedAt: entry?.addedAt ?? Date.now() });
    const state = await tx.objectStore('chapterState').get(cKey);
    await tx.objectStore('downloads').put({ key: cKey, mangaKey: key, cacheKey: stagingKey, pageCount: names.length, byteSize, downloadedAt: Date.now(), pages });
    await tx.objectStore('chapterState').put({ key: cKey, mangaKey: key, read: false, lastPage: 0, ...state, downloaded: true });
    await tx.done;
    committed = true;
    dispatchDataEvent('mihon:library-changed');
    dispatchDataEvent('mihon:downloads-changed');
    if (previousDownload) await Promise.allSettled(Array.from({ length: previousDownload.pageCount }, (_, i) => cache.delete(pageCacheKey(previousDownload.cacheKey ?? cKey, i))));
    return { mangaKey: key, pageCount: names.length, chapterName: chapter.name };
  } finally { if (!committed) await Promise.allSettled(names.map((_, i) => cache.delete(pageCacheKey(stagingKey, i)))); }
}
function xml(value: string): string { return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!); }
export async function exportChapterCbz(key: string, cKey: string): Promise<void> {
  const db = await getDB();
  const [manga, chapter, download] = await Promise.all([getManga(key), db.get('chapterMeta', cKey), db.get('downloads', cKey)]);
  if (!manga || !chapter || !download) throw new Error('This chapter is not downloaded');
  const cache = await caches.open(PAGES_CACHE);
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < download.pageCount; i++) {
    const response = await cache.match(pageCacheKey(download.cacheKey ?? cKey, i));
    if (!response) throw new Error('Some pages are missing. Download the chapter again before exporting.');
    const mime = response.headers.get('Content-Type') ?? 'image/jpeg';
    const ext = Object.entries(MIME).find(([, value]) => value === mime)?.[0] ?? (mime.includes('svg') ? 'svg' : 'jpg');
    files[`${String(i + 1).padStart(4, '0')}.${ext}`] = new Uint8Array(await response.arrayBuffer());
  }
  files['ComicInfo.xml'] = strToU8(`<?xml version="1.0"?><ComicInfo><Series>${xml(manga.manga.title)}</Series><Title>${xml(chapter.chapter.name)}</Title><Number>${chapter.chapter.number}</Number><PageCount>${download.pageCount}</PageCount></ComicInfo>`);
  saveFile(new Blob([blobPart(await makeZip(files))], { type: 'application/vnd.comicbook+zip' }), `${manga.manga.title} - ${chapter.chapter.name}.cbz`);
}
