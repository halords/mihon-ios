import { afterEach, expect, it, vi } from 'vitest';
import { registerSource, unregisterSource } from '../src/sources';
import { putManga, putChapterMetas, getDB, getChapterState } from '../src/lib/db';
import { commitDownload, downloadChapter, getCachedPageList, getCachedChapterPages, pageCacheKey, PAGES_CACHE, reconcileDownloads, deleteChapterDownload } from '../src/lib/downloads';
import { fetchImage, cdnUrl, proxiedUrl } from '../src/lib/fetchJson';
import { saveSettings } from '../src/lib/settings';
import { testSource } from './fixtures/source';
import { svgPage } from './fixtures/mihon';

const key = 'test-source::/hero';
const chapterKey = key + '::/chapter/1';
afterEach(() => { unregisterSource('test-source'); vi.unstubAllGlobals(); });
async function setup() {
  const fixture = testSource();
  fixture.source.getPageList = vi.fn(async () => Array.from({ length: 3 }, (_, i) => ({ imageUrl: 'https://pages.example/' + i + '.svg' })));
  registerSource(fixture.source);
  await putManga(fixture.manga);
  await putChapterMetas(fixture.source.id, fixture.manga.id, fixture.chapters);
  return fixture;
}
it('resumes partial pages after cancellation and commits only a complete chapter', async () => {
  await setup();
  const fetch = vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } }));
  vi.stubGlobal('fetch', fetch);
  const abort = new AbortController();
  await expect(downloadChapter(key, chapterKey, 'test-source', '/hero', '/chapter/1', done => { if (done === 1) abort.abort(); }, abort.signal)).rejects.toThrow();
  expect(await (await getDB()).get('downloads', chapterKey)).toBeUndefined();
  expect(await (await caches.open(PAGES_CACHE)).match(pageCacheKey(chapterKey, 0))).toBeDefined();
  await downloadChapter(key, chapterKey, 'test-source', '/hero', '/chapter/1');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await getChapterState(chapterKey)).toMatchObject({ downloaded: true });
  expect((await getCachedPageList(chapterKey))?.length).toBe(3);
});
it('reads a downloaded chapter without a source and detects missing cached pages', async () => {
  await setup();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } })));
  await downloadChapter(key, chapterKey, 'test-source', '/hero', '/chapter/1');
  unregisterSource('test-source');
  (navigator as { onLine: boolean }).onLine = false;
  const pages = await getCachedChapterPages(chapterKey);
  expect(pages).toHaveLength(3);
  pages!.forEach(url => URL.revokeObjectURL(url));
  await (await caches.open(PAGES_CACHE)).delete(pageCacheKey(chapterKey, 1));
  expect(await getCachedPageList(chapterKey)).toBeNull();
  expect(await reconcileDownloads()).toBe(1);
  expect(await getChapterState(chapterKey)).toMatchObject({ downloaded: false });
});
it('rejects false complete manifests, zero-page sources, and HTML disguised as an image', async () => {
  const { source } = await setup();
  const cache = await caches.open(PAGES_CACHE);
  await cache.put(pageCacheKey(chapterKey, 0), new Response(svgPage('One')));
  await expect(commitDownload({ key: chapterKey, mangaKey: key, pageCount: 2, downloadedAt: Date.now() })).rejects.toThrow(/missing/);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeUndefined();
  source.getPageList = vi.fn(async () => []);
  await expect(downloadChapter(key, chapterKey, 'test-source', '/hero', '/chapter/1')).rejects.toThrow(/no downloadable pages/);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>blocked</html>', { headers: { 'Content-Type': 'image/jpeg' } })));
  await expect(fetchImage('https://pages.example/page.jpg')).rejects.toThrow(/valid image/);
});
it('uses compact hashes for large data URI downloads and preserves reading state on deletion', async () => {
  const { source } = await setup();
  source.getPageList = vi.fn(async () => [{ imageUrl: 'data:image/svg+xml,' + encodeURIComponent(svgPage('x'.repeat(70000))) }]);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } })));
  await downloadChapter(key, chapterKey, 'test-source', '/hero', '/chapter/1');
  const response = await (await caches.open(PAGES_CACHE)).match(pageCacheKey(chapterKey, 0));
  expect(response!.headers.get('X-Mihon-Page')).toHaveLength(64);
  const db = await getDB();
  await db.put('chapterState', { key: chapterKey, mangaKey: key, downloaded: true, read: true, bookmark: true, lastPage: 12 });
  await deleteChapterDownload(key, chapterKey);
  expect(await getChapterState(chapterKey)).toMatchObject({ downloaded: false, read: true, bookmark: true, lastPage: 12 });
});
it('honors custom proxy templates for every source without double proxying or forwarding server credentials', () => {
  saveSettings({ proxyBase: 'https://proxy.example/?url=', suwayomiUrl: 'https://server.example' });
  const target = 'https://pages.example/chapter/1?a=b';
  const proxied = cdnUrl(target);
  expect(new URL(proxied).searchParams.get('url')).toBe(target);
  expect(cdnUrl(proxied)).toBe(proxied);
  expect(cdnUrl('https://server.example/api/v1/manga/1/thumbnail')).toBe('https://server.example/api/v1/manga/1/thumbnail');
  saveSettings({ proxyBase: 'https://proxy.example/fetch?target={url}' });
  expect(proxiedUrl(target)).toBe('https://proxy.example/fetch?target=' + encodeURIComponent(target));
});

it('downloads pages through a parallel pool and stores them in page order', async () => {
  const fixture = testSource();
  fixture.source.getPageList = vi.fn(async () => Array.from({ length: 6 }, (_, i) => ({ imageUrl: 'https://pages.example/' + i + '.svg' })));
  registerSource(fixture.source);
  await putManga(fixture.manga);
  await putChapterMetas(fixture.source.id, fixture.manga.id, fixture.chapters);
  let inFlight = 0; let maxInFlight = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 25));
    inFlight--;
    return new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } });
  }));
  await downloadChapter(key, chapterKey, 'test-source', '/hero', '/chapter/1');
  expect(maxInFlight).toBeGreaterThan(1);
  expect((await getCachedPageList(chapterKey))?.length).toBe(6);
  const record = await (await getDB()).get('downloads', chapterKey);
  expect(record?.pageCount).toBe(6); expect(record?.pages).toHaveLength(6);
});

it('cache-busts retries after non-image responses and preserves the URL hash', async () => {
  const fixture = testSource();
  fixture.source.getPageList = vi.fn(async () => [{ imageUrl: 'https://pages.example/p.svg?x=1#frag=1' }]);
  registerSource(fixture.source);
  await putManga(fixture.manga);
  await putChapterMetas(fixture.source.id, fixture.manga.id, fixture.chapters);
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url));
    return urls.length < 3
      ? new Response('<html>interstitial</html>', { headers: { 'Content-Type': 'text/html' } })
      : new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } });
  }));
  await downloadChapter(key, chapterKey, 'test-source', '/hero', '/chapter/1');
  // The first fetch uses the original URL; each retry after a non-image
  // response is cache-busted in the query, with the hash byte-identical.
  expect(urls).toEqual([
    'https://pages.example/p.svg?x=1#frag=1',
    'https://pages.example/p.svg?x=1&_r=1#frag=1',
    'https://pages.example/p.svg?x=1&_r=2#frag=1',
  ]);
  expect(await getChapterState(chapterKey)).toMatchObject({ downloaded: true });
});
