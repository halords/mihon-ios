import { afterEach, expect, it, vi } from 'vitest';
import { registerSource, unregisterSource } from '../src/sources';
import { putManga, putChapterMetas, getDB, getChapterState, patchChapterState } from '../src/lib/db';
import { downloadChapter, maybeAutoDeleteReadChapter } from '../src/lib/downloads';
import { saveSettings } from '../src/lib/settings';
import { testSource } from './fixtures/source';
import { svgPage } from './fixtures/mihon';

const key = 'autodel-source::/hero';
const chapterKey = key + '::/chapter/1';

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
  await maybeAutoDeleteReadChapter(key, chapterKey);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeDefined();
  await patchChapterState(chapterKey, key, { read: true });
  await maybeAutoDeleteReadChapter(key, chapterKey);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeUndefined();
  expect(await getChapterState(chapterKey)).toMatchObject({ read: true, downloaded: false });
});

it('keeps the download when the setting is off', async () => {
  await setupDownloaded();
  saveSettings({ deleteReadDownloads: false });
  await patchChapterState(chapterKey, key, { read: true });
  await maybeAutoDeleteReadChapter(key, chapterKey);
  expect(await (await getDB()).get('downloads', chapterKey)).toBeDefined();
  expect(await getChapterState(chapterKey)).toMatchObject({ read: true, downloaded: true });
});
