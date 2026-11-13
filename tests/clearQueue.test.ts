// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const deleteChapterDownload = vi.fn(async (_mangaKey: string, _key: string) => {});
vi.mock('../src/lib/downloads', () => ({
  downloadChapter: vi.fn(async () => 3),
  deleteChapterDownload: (mangaKey: string, key: string) => deleteChapterDownload(mangaKey, key),
  getChapterDownload: vi.fn(async () => undefined),
}));

const { getDB, getDownloadJobs, putManga, putChapterMetas } = await import('../src/lib/db');
const { clearDownloadQueue, enqueueChapters, getQueueSnapshot, setDownloadsPaused } = await import('../src/lib/downloadQueue');
const { registerSource, unregisterSource } = await import('../src/sources');
const { testSource } = await import('./fixtures/source');

const key = 'clearq-source::/hero';

beforeEach(() => { deleteChapterDownload.mockReset(); deleteChapterDownload.mockImplementation(async () => {}); });
afterEach(async () => { await clearDownloadQueue(); unregisterSource('clearq-source'); });

async function setup() {
  const f = testSource('clearq-source');
  registerSource(f.source);
  await putManga(f.manga);
  await putChapterMetas(f.source.id, f.manga.id, f.chapters);
  await (await getDB()).put('metadata', { key: 'downloads:paused', value: true });
  const ids = f.chapters.map(c => c.id);
  await enqueueChapters(key, ids);
  expect(await getDownloadJobs()).toHaveLength(ids.length);
  return ids;
}

it('clear queue removes every job and cleans up each one', async () => {
  const ids = await setup();
  await clearDownloadQueue();
  expect(await getDownloadJobs()).toHaveLength(0);
  expect(deleteChapterDownload).toHaveBeenCalledTimes(ids.length);
});

it('one failing page cleanup does not strand the rest of the queue', async () => {
  const ids = await setup();
  deleteChapterDownload.mockImplementation(async (_m: string, k: string) => {
    if (k.includes(ids[0])) throw new Error('cache cleanup exploded');
  });
  await clearDownloadQueue();
  expect(await getDownloadJobs()).toHaveLength(0);
  expect(deleteChapterDownload).toHaveBeenCalledTimes(ids.length);
});

it('clear queue restores the unpaused state so later downloads run', async () => {
  // The module-level queue snapshot persists across tests in this file;
  // normalize first, then set up (setup seeds paused=true) and unpause.
  await setDownloadsPaused(false);
  const ids = await setup();
  await setDownloadsPaused(false);
  await clearDownloadQueue();
  expect(getQueueSnapshot().paused).toBe(false);
  expect((await (await getDB()).get('metadata', 'downloads:paused'))?.value).toBe(false);
  // A chapter enqueued after the clear must actually download (the pump
  // runs it through the mocked downloadChapter) instead of stalling.
  await enqueueChapters(key, [ids[0]!]);
  const deadline = Date.now() + 2000;
  while ((await getDownloadJobs()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(await getDownloadJobs()).toHaveLength(0);
});

it('clear queue keeps the queue paused when it was paused before', async () => {
  await setDownloadsPaused(true);
  await setup();
  await clearDownloadQueue();
  expect(getQueueSnapshot().paused).toBe(true);
  expect((await (await getDB()).get('metadata', 'downloads:paused'))?.value).toBe(true);
  expect(await getDownloadJobs()).toHaveLength(0);
});
