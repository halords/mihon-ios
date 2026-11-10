import { afterEach, expect, it, vi } from 'vitest';
import { clearDownloadQueue, enqueueChapters, setDownloadsPaused } from '../src/lib/downloadQueue';
import { getAllDownloads, getDB, getDownloadJobs, putManga, putChapterMetas } from '../src/lib/db';
import { registerSource, unregisterSource } from '../src/sources';
import { testSource } from './fixtures/source';
import { svgPage } from './fixtures/mihon';
const key = 'queue-source::/hero';
afterEach(async () => { await clearDownloadQueue(); unregisterSource('queue-source'); vi.unstubAllGlobals(); });
async function setup() {
  const f = testSource('queue-source');
  f.source.getPageList = async chapterId => [{ imageUrl: 'https://pages.example/' + chapterId + '/1.svg' }];
  registerSource(f.source); await putManga(f.manga); await putChapterMetas(f.source.id, f.manga.id, f.chapters);
  await (await getDB()).put('metadata', { key: 'downloads:paused', value: true });
  return f;
}
it('processes work enqueued while the previous pump is releasing its wake lock', async () => {
  await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const releaseLock = vi.fn(async () => gate);
  (navigator as unknown as { wakeLock: unknown }).wakeLock = { request: async () => ({ release: releaseLock }) };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } })));
  await enqueueChapters(key, ['/chapter/1']);
  await setDownloadsPaused(false);
  await vi.waitFor(() => expect(releaseLock).toHaveBeenCalled());
  await enqueueChapters(key, ['/chapter/2']);
  release();
  await vi.waitFor(async () => expect(await getAllDownloads()).toHaveLength(2));
  await vi.waitFor(async () => expect(await getDownloadJobs()).toHaveLength(0));
});
it('pauses, resumes partial progress, and clears queued jobs without duplicating saved pages', async () => {
  const f = await setup();
  f.source.getPageList = async () => [{ imageUrl: 'https://pages.example/one.svg' }, { imageUrl: 'https://pages.example/two.svg' }];
  let secondRequested = false;
  let firstAttempt = true;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('two.svg') && firstAttempt) {
      secondRequested = true;
      return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    }
    return new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } });
  });
  vi.stubGlobal('fetch', fetch);
  await enqueueChapters(key, ['/chapter/1']);
  await setDownloadsPaused(false);
  await vi.waitFor(() => expect(secondRequested).toBe(true));
  await setDownloadsPaused(true);
  await vi.waitFor(async () => expect((await getDownloadJobs())[0]?.status).toBe('paused'));
  firstAttempt = false;
  await setDownloadsPaused(false);
  await vi.waitFor(async () => expect(await getAllDownloads()).toHaveLength(1));
  expect(fetch).toHaveBeenCalledTimes(3);
});
