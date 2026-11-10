// Point these variables at a disposable Suwayomi instance. This check creates
// synthetic local chapters and restores a synthetic Mihon library on that server.
import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, zipSync } from 'fflate';
import { bytes, concat, float, integer, string } from './fixtures/mihon';
import { inspectTachibkFile, restoreTachibk } from '../src/backup/tachibk';
import { connectSuwayomi, sendBackupToServer, setBackendAuth } from '../src/lib/suwayomi';
import { getArchives, getChapterMetas, getChapterState, getDB } from '../src/lib/db';
import { downloadChapter, getCachedPageList, pageCacheKey, PAGES_CACHE } from '../src/lib/downloads';
import { getSource } from '../src/sources';
import { createMihonBackup } from '../src/backup/export';

it('restores a Mihon archive through live Suwayomi and downloads its chapter for offline reading', async () => {
  const base = process.env.SUWAYOMI_TEST_URL;
  const dataDir = process.env.SUWAYOMI_TEST_DATA;
  if (!base || !dataDir) throw new Error('Set SUWAYOMI_TEST_URL and SUWAYOMI_TEST_DATA for a disposable server. See docs/SUWAYOMI.md.');
  const title = 'PWA Contract Fixture';
  const folder = join(dataDir, 'local', title);
  const image = await readFile(new URL('../public/icons/icon-192.png', import.meta.url));
  await mkdir(folder, { recursive: true });
  for (const number of [1, 2]) await writeFile(join(folder, `Chapter ${number}.cbz`), zipSync({ '001.png': image, '002.png': image }));
  const origin = new URL(base).origin;
  vi.stubGlobal('location', { origin, protocol: new URL(base).protocol, hash: '' });
  if (process.env.SUWAYOMI_TEST_USERNAME) setBackendAuth(process.env.SUWAYOMI_TEST_USERNAME, process.env.SUWAYOMI_TEST_PASSWORD ?? '');
  // Node has no cookie jar. Model same-origin browser cookie behavior, including
  // Suwayomi's Basic-auth multipart CSRF session, without storing credentials.
  const nativeFetch = globalThis.fetch;
  const cookies = new Map<string, string>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), origin);
    const headers = new Headers(init?.headers);
    if (url.origin === origin && cookies.size) headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await nativeFetch(url, { ...init, headers });
    if (url.origin === origin) for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!;
      const split = pair.indexOf('=');
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
      if (new URL(base).pathname.startsWith('/api/suwayomi')) expect(cookie).toContain('Path=/api/suwayomi/');
    }
    return response;
  });
  await connectSuwayomi(base);
  const wireChapter = (number: number) => concat(string(1, `${title}/Chapter ${number}.cbz`), string(2, `Chapter ${number}`), integer(4, number === 1 ? 1 : 0), integer(5, 1), integer(6, 0), float(9, number));
  const wire = concat(
    bytes(1, concat(integer(1, 0), string(2, title), string(3, title), bytes(16, wireChapter(1)), bytes(16, wireChapter(2)), integer(17, 5))),
    bytes(2, concat(string(1, 'Contract category'), integer(2, 5), integer(3, 7))),
    bytes(101, concat(string(1, 'Local source'), integer(2, 0))),
  );
  await restoreTachibk(await inspectTachibkFile(new File([gzipSync(wire)], 'server-contract.tachibk')));
  const generated = await createMihonBackup();
  await sendBackupToServer({ ...(await getArchives())[0]!, name: 'generated-pwa.tachibk', bytes: generated.file });
  const source = getSource('0')!;
  expect((await source.getMangaDetails(title)).title).toBe(title);
  const chapters = await source.getChapterList(title);
  expect(chapters).toHaveLength(2);
  expect((await getChapterMetas('0::' + title))).toHaveLength(2);
  const chapter = chapters.find(c => c.number === 2)!;
  const pages = await source.getPageList(chapter.id, title);
  expect(pages).toHaveLength(2);
  expect(pages[0]!.imageUrl).toContain('/api/v1/manga/');
  const key = `0::${title}::${chapter.id}`;
  await downloadChapter('0::' + title, key, '0', title, chapter.id);
  expect((await (await getDB()).get('downloads', key))?.pageCount).toBe(2);
  expect(await getChapterState(key)).toMatchObject({ downloaded: true, bookmark: true });
  await connectSuwayomi('');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Offline'));
  expect(await getCachedPageList(key)).toHaveLength(2);
  const cached = await (await caches.open(PAGES_CACHE)).match(pageCacheKey(key, 0));
  expect(cached?.headers.get('Content-Type')).toBe('image/png');
  expect(new Uint8Array(await cached!.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
});
