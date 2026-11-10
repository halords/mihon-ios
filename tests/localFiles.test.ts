import { expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { importCbz } from '../src/lib/localFiles';
import { getDB, getChapterMetas, getChapterState, patchChapterState, getDownload } from '../src/lib/db';
import { PAGES_CACHE, pageCacheKey } from '../src/lib/downloads';
import { svgPage } from './fixtures/mihon';
function cbz(pages: Record<string, string>, name = 'Chapter 1.cbz') { return new File([zipSync(Object.fromEntries(Object.entries(pages).map(([path, value]) => [path, strToU8(value)])))], name); }
it('imports pages in natural order and rejects non-image archives without adding library entries', async () => {
  const result = await importCbz(cbz({ '10.svg': svgPage('ten'), '2.svg': svgPage('two'), '1.svg': svgPage('one'), '__MACOSX/no.svg': svgPage('ignored') }), 'Offline Hero');
  expect(result.pageCount).toBe(3);
  const chapter = (await getChapterMetas(result.mangaKey))[0]!;
  const download = await getDownload(chapter.key);
  const page = await (await caches.open(PAGES_CACHE)).match(pageCacheKey(download!.cacheKey!, 1));
  expect(await page!.text()).toContain('two');
  await expect(importCbz(cbz({ 'fake.png': '<html>not an image</html>' }), 'Invalid title')).rejects.toThrow(/supported image/);
  expect(await (await getDB()).count('library')).toBe(1);
});
it('replaces an existing chapter atomically while preserving progress and bookmarks', async () => {
  const first = await importCbz(cbz({ '1.svg': svgPage('original') }), 'Offline Hero');
  const chapter = (await getChapterMetas(first.mangaKey))[0]!;
  await patchChapterState(chapter.key, first.mangaKey, { lastPage: 6, bookmark: true, read: true });
  const before = await getDownload(chapter.key);
  await expect(importCbz(cbz({ '1.svg': svgPage('staged'), '2.png': 'broken' }), '', first.mangaKey)).rejects.toThrow(/supported image/);
  expect((await getDownload(chapter.key))?.cacheKey).toBe(before!.cacheKey);
  const old = await (await caches.open(PAGES_CACHE)).match(pageCacheKey(before!.cacheKey!, 0));
  expect(await old!.text()).toContain('original');
  await importCbz(cbz({ '1.svg': svgPage('replacement') }), '', first.mangaKey);
  expect((await getDownload(chapter.key))?.cacheKey).not.toBe(before!.cacheKey);
  expect(await getChapterState(chapter.key)).toMatchObject({ lastPage: 6, bookmark: true, read: true, downloaded: true });
});
it('does not report a committed CBZ replacement as failed when obsolete cache cleanup fails', async () => {
  const first = await importCbz(cbz({ '1.svg': svgPage('old') }), 'Offline Hero');
  const cache = await caches.open(PAGES_CACHE);
  vi.spyOn(cache, 'delete').mockRejectedValue(new Error('Cleanup unavailable'));
  await expect(importCbz(cbz({ '1.svg': svgPage('new') }), '', first.mangaKey)).resolves.toMatchObject({ pageCount: 1 });
});
