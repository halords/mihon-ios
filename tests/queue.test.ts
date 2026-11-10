import { afterEach, expect, it, vi } from 'vitest';
import { AUTO_RETRY_DELAYS_MS, clearDownloadQueue, enqueueChapters, retryDownload, setDownloadsPaused, type DownloadJobRecord } from '../src/lib/downloadQueue';
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

function shortenDelays(transient: [number, number], rateLimit: [number, number]): () => void {
  const saved = { transient: [...AUTO_RETRY_DELAYS_MS.transient], rateLimit: [...AUTO_RETRY_DELAYS_MS.rateLimit] };
  AUTO_RETRY_DELAYS_MS.transient.splice(0, AUTO_RETRY_DELAYS_MS.transient.length, ...transient);
  AUTO_RETRY_DELAYS_MS.rateLimit.splice(0, AUTO_RETRY_DELAYS_MS.rateLimit.length, ...rateLimit);
  return () => {
    AUTO_RETRY_DELAYS_MS.transient.splice(0, AUTO_RETRY_DELAYS_MS.transient.length, ...saved.transient);
    AUTO_RETRY_DELAYS_MS.rateLimit.splice(0, AUTO_RETRY_DELAYS_MS.rateLimit.length, ...saved.rateLimit);
  };
}

it('auto-retries rate-limited chapters after a long cooldown, exhausts after two retries, and resets on manual retry', async () => {
  const f = await setup();
  let calls = 0; let failing = true;
  f.source.getPageList = async () => {
    calls++;
    if (failing) throw new Error('Image download failed (HTTP 503)');
    return [{ imageUrl: 'https://pages.example/ok.svg' }];
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } })));
  await enqueueChapters(key, ['/chapter/1']);
  await setDownloadsPaused(false);
  // The first failure re-queues instead of failing, with one retry used
  // and the ~60s rate-limit cooldown recorded. The pump parks in its
  // cooldown wait, so this state is stable to observe.
  await vi.waitFor(async () => {
    const job = (await getDownloadJobs())[0] as DownloadJobRecord | undefined;
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(job?.notBefore).toBeGreaterThan(Date.now() + 30000);
  });
  const restore = shortenDelays([5000, 15000], [20, 40]);
  try {
    const job = (await getDownloadJobs())[0]!;
    await (await getDB()).put('downloadQueue', { ...job, notBefore: Date.now() - 1 });
    // The waiting pump re-reads due times every tick, so the edited
    // notBefore is picked up without any pause/unpause or manual retry.
    await vi.waitFor(async () => {
      const current = (await getDownloadJobs())[0];
      expect(current?.status).toBe('failed');
      expect(current?.error).toContain('HTTP 503');
    });
    expect(calls).toBe(3); // the initial run plus two automatic retries
    failing = false;
    await retryDownload(job.key);
    await vi.waitFor(async () => expect(await getAllDownloads()).toHaveLength(1));
    await vi.waitFor(async () => expect(await getDownloadJobs()).toHaveLength(0));
  } finally { restore(); }
});

it('schedules an ordinary transient failure for an automatic retry about five seconds out', async () => {
  const f = await setup();
  f.source.getPageList = async () => { throw new Error('The source did not return a valid image'); };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } })));
  await enqueueChapters(key, ['/chapter/1']);
  await setDownloadsPaused(false);
  await vi.waitFor(async () => {
    const job = (await getDownloadJobs())[0] as DownloadJobRecord | undefined;
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(job?.notBefore).toBeGreaterThan(Date.now() + 2500);
    expect(job?.notBefore).toBeLessThan(Date.now() + 10000);
  });
  await setDownloadsPaused(true);
});

it('fails non-transient errors immediately with no automatic retry', async () => {
  const f = await setup();
  let calls = 0;
  f.source.getPageList = async () => { calls++; throw new Error('Device storage is full. Delete some downloads and retry.'); };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } })));
  await enqueueChapters(key, ['/chapter/1']);
  await setDownloadsPaused(false);
  await vi.waitFor(async () => {
    const job = (await getDownloadJobs())[0] as DownloadJobRecord | undefined;
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('Device storage is full');
    expect(job?.attempts).toBeUndefined();
  });
  expect(calls).toBe(1);
});

it('downloads chapters oldest first regardless of enqueue order', async () => {
  const f = testSource('queue-source', 3);
  const order: string[] = [];
  f.source.getPageList = async chapterId => { order.push(chapterId); return [{ imageUrl: 'https://pages.example/' + chapterId + '/1.svg' }]; };
  registerSource(f.source); await putManga(f.manga); await putChapterMetas(f.source.id, f.manga.id, f.chapters);
  await (await getDB()).put('metadata', { key: 'downloads:paused', value: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(svgPage('Page'), { headers: { 'Content-Type': 'image/svg+xml' } })));
  await enqueueChapters(key, ['/chapter/3', '/chapter/1', '/chapter/2']);
  await setDownloadsPaused(false);
  await vi.waitFor(async () => expect(await getDownloadJobs()).toHaveLength(0));
  expect(order).toEqual(['/chapter/1', '/chapter/2', '/chapter/3']);
});
