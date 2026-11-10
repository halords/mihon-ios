import { expect, it, vi } from 'vitest';
import { addToLibrary, downloadRemovalKey, getDB, getRawDB, putManga, removeFromLibrary } from '../src/lib/db';
import { downloadChapter, pageCacheKey, PAGES_CACHE } from '../src/lib/downloads';
import { applyRemoteChanges } from '../src/lib/account';
import { resumeLibraryFileCleanup } from '../src/lib/libraryFiles';
import { syncId } from '../src/lib/syncTypes';
import { registerSource, unregisterSource } from '../src/sources';
import { testSource } from './fixtures/source';
import { svgPage } from './fixtures/mihon';

const key = 'removal-source::/hero'; const chapter = key + '::one';
async function seed() {
  const db = await getDB();
  await putManga({ id: '/hero', sourceId: 'removal-source', title: 'Hero', coverUrl: 'https://covers.example/hero.jpg', description: '', genres: [], status: 'Ongoing' });
  await addToLibrary(key, 'Reading');
  await db.put('chapterState', { key: chapter, mangaKey: key, read: true, downloaded: true, bookmark: true, lastPage: 8, pageOffset: .3 });
  await db.put('history', { key: chapter, mangaKey: key, mangaTitle: 'Hero', coverUrl: '', chapterName: 'One', updatedAt: 10, page: 8 });
  await db.put('downloads', { key: chapter, mangaKey: key, cacheKey: 'cbz-staging:old-import', pageCount: 1, downloadedAt: 1 });
  await db.put('downloadQueue', { key: key + '::two', mangaKey: key, sourceId: 'removal-source', mangaId: '/hero', chapterId: 'two', mangaTitle: 'Hero', chapterName: 'Two', status: 'paused', done: 1, total: 3, createdAt: 1, updatedAt: 1 });
  const cache = await caches.open(PAGES_CACHE);
  await cache.put(pageCacheKey('cbz-staging:old-import', 0), new Response('saved chapter'));
  await cache.put(pageCacheKey(key + '::two', 0), new Response('partial chapter'));
  await cache.put(pageCacheKey(key + '-other::one', 0), new Response('another title'));
  await (await caches.open('mihon-covers-v1')).put('https://cache.mihon.local/cover/' + encodeURIComponent('https://covers.example/hero.jpg'), new Response('cover'));
  return db;
}
it('removes complete, imported and partial chapter files and queued jobs while preserving reading data and other titles', async () => {
  const db = await seed();
  await removeFromLibrary(key);
  expect(await db.get('library', key)).toBeUndefined();
  expect(await db.count('downloads')).toBe(0); expect(await db.count('downloadQueue')).toBe(0);
  expect((await (await caches.open(PAGES_CACHE)).keys()).map(request => request.url)).toEqual([pageCacheKey(key + '-other::one', 0)]);
  expect(await (await caches.open('mihon-covers-v1')).keys()).toHaveLength(0);
  expect(await db.get('chapterState', chapter)).toMatchObject({ downloaded: false, read: true, bookmark: true, lastPage: 8, pageOffset: .3 });
  expect(await db.get('history', chapter)).toBeDefined();
  expect(await db.get('metadata', downloadRemovalKey(key))).toMatchObject({ value: { pending: false } });
});
it('cleans files for an accepted remote removal and resumes an interrupted cleanup', async () => {
  const db = await seed();
  await applyRemoteChanges([{ id: syncId('library', key), store: 'library', key, clock: Date.now() + 100000,
    deviceId: 'remote', revision: 1, deleted: true, data: null }], 1, 'guest');
  expect(await db.count('downloads')).toBe(0);
  await addToLibrary(key, 'Reading');
  expect(await db.get('metadata', downloadRemovalKey(key))).toBeUndefined();
  await (await caches.open(PAGES_CACHE)).put(pageCacheKey(chapter, 0), new Response('interrupted'));
  const raw = await getRawDB();
  await raw.delete('library', key); await raw.put('metadata', { key: downloadRemovalKey(key), value: { pending: true } });
  await resumeLibraryFileCleanup();
  expect(await (await caches.open(PAGES_CACHE)).match(pageCacheKey(chapter, 0))).toBeUndefined();
});
it('cancels an in-progress download without allowing its files or manifest to return', async () => {
  const db = await seed(); await db.clear('downloads');
  const fixture = testSource('removal-source');
  fixture.source.getPageList = async () => [{ imageUrl: 'https://pages.example/1.svg' }, { imageUrl: 'https://pages.example/2.svg' }];
  registerSource(fixture.source);
  let pending = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.includes('2.svg')) { pending = true; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })); }
    return new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } });
  }));
  try {
    const downloading = downloadChapter(key, chapter, 'removal-source', '/hero', 'one').catch(error => error);
    await vi.waitFor(() => expect(pending).toBe(true));
    await removeFromLibrary(key); expect(await downloading).toBeInstanceOf(Error);
    expect(await db.get('downloads', chapter)).toBeUndefined();
    expect(await (await caches.open(PAGES_CACHE)).match(pageCacheKey(chapter, 0))).toBeUndefined();
    await expect(downloadChapter(key, chapter, 'removal-source', '/hero', 'one')).rejects.toThrow(/back to your library/);
  } finally { unregisterSource('removal-source'); }
});
