import { afterEach, expect, it, vi } from 'vitest';
import { registerSource, unregisterSource } from '../src/sources';
import { putManga, putChapterMetas, getDB, getChapterState, patchChapterState } from '../src/lib/db';
import { deleteChapterDownload, downloadChapter, maybeAutoDeleteReadChapter, pageCacheKey, PAGES_CACHE, sweepAutoDeleteReadChapters } from '../src/lib/downloads';
import { saveSettings } from '../src/lib/settings';
import { testSource } from './fixtures/source';
import { svgPage } from './fixtures/mihon';

const key = 'autodel-source::/hero';
const chapterKey = key + '::/chapter/1';
const chapterKey2 = key + '::/chapter/2';

afterEach(() => { unregisterSource('autodel-source'); vi.unstubAllGlobals(); saveSettings({ deleteReadDownloads: true }); });

async function setupDownloaded() {
  const fixture = testSource('autodel-source');
  fixture.source.getPageList = vi.fn(async () => Array.from({ length: 3 }, (_, i) => ({ imageUrl: 'https://pages.example/' + i + '.svg' })));
  registerSource(fixture.source);
  await putManga(fixture.manga);
  await putChapterMetas(fixture.source.id, fixture.manga.id, fixture.chapters);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } })));
  await downloadChapter(key, chapterKey, 'autodel-source', '/hero', '/chapter/1');
  expect(await (await getDB()).get('downloads', chapterKey)).toBeDefined();
  return fixture;
}

it('deletes the download once the chapter is fully read (setting on by default)', async () => {
  await setupDownloaded();
  expect(await maybeAutoDeleteReadChapter(key, chapterKey)).toBe(false);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeDefined();
  await patchChapterState(chapterKey, key, { read: true });
  expect(await maybeAutoDeleteReadChapter(key, chapterKey)).toBe(true);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeUndefined();
  expect(await getChapterState(chapterKey)).toMatchObject({ read: true, downloaded: false });
});

it('keeps the download when the setting is off', async () => {
  await setupDownloaded();
  saveSettings({ deleteReadDownloads: false });
  await patchChapterState(chapterKey, key, { read: true });
  expect(await maybeAutoDeleteReadChapter(key, chapterKey)).toBe(false);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeDefined();
  expect(await getChapterState(chapterKey)).toMatchObject({ read: true, downloaded: true });
});

it('deletes only the target chapter pages, leaving other chapters cached', async () => {
  await setupDownloaded();
  await downloadChapter(key, chapterKey2, 'autodel-source', '/hero', '/chapter/2');
  const cache = await caches.open(PAGES_CACHE);
  expect(await cache.match(pageCacheKey(chapterKey2, 0))).toBeDefined();
  await deleteChapterDownload(key, chapterKey);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeUndefined();
  expect(await cache.match(pageCacheKey(chapterKey, 0))).toBeUndefined();
  expect(await cache.match(pageCacheKey(chapterKey, 2))).toBeUndefined();
  expect(await (await getDB()).get('downloads', chapterKey2)).toBeDefined();
  expect(await cache.match(pageCacheKey(chapterKey2, 0))).toBeDefined();
  expect(await getChapterState(chapterKey2)).toMatchObject({ downloaded: true });
});

it('startup sweep deletes read chapters and keeps unread ones', async () => {
  await setupDownloaded();
  await downloadChapter(key, chapterKey2, 'autodel-source', '/hero', '/chapter/2');
  await patchChapterState(chapterKey, key, { read: true });
  expect(await sweepAutoDeleteReadChapters()).toBe(1);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeUndefined();
  expect(await getChapterState(chapterKey)).toMatchObject({ read: true, downloaded: false });
  expect(await (await caches.open(PAGES_CACHE)).match(pageCacheKey(chapterKey, 0))).toBeUndefined();
  expect(await (await getDB()).get('downloads', chapterKey2)).toBeDefined();
  expect(await getChapterState(chapterKey2)).toMatchObject({ downloaded: true });
});

it('startup sweep deletes nothing when the setting is off', async () => {
  await setupDownloaded();
  saveSettings({ deleteReadDownloads: false });
  await patchChapterState(chapterKey, key, { read: true });
  expect(await sweepAutoDeleteReadChapters()).toBe(0);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeDefined();
  expect(await getChapterState(chapterKey)).toMatchObject({ read: true, downloaded: true });
});
