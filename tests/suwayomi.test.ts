import { afterEach, expect, it, vi } from 'vitest';
import { connectSuwayomi, getConnectionSnapshot, sendBackupToServer } from '../src/lib/suwayomi';
import { getDB, putManga, putChapterMetas } from '../src/lib/db';
import { getSource } from '../src/sources';
import { EXACT_SOURCE } from './fixtures/mihon';

const base = 'https://server.example';
const id = String(EXACT_SOURCE);
const info = { id, name: 'Android source', lang: 'en', supportsLatest: true, baseUrl: 'https://source.example' };
const manga = { id: 41, url: '/series/hero', title: 'Hero', status: 'ONGOING', genre: [], thumbnailUrl: '/api/v1/manga/41/thumbnail' };
const chapters = [{ id: 51, url: '/chapter/2', name: 'Chapter 2', chapterNumber: 2, uploadDate: '1794000000000', scanlator: 'Group', sourceOrder: 0 }];
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
afterEach(async () => { await connectSuwayomi(''); });

function mockServer() {
  const requests: { url: string; query: string; variables: any }[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    requests.push({ url: String(url), query, variables });
    if (query.includes('query Sources')) return json({ sources: { nodes: [info], totalCount: 1 } });
    if (query.includes('ResolveManga')) return json({ mangas: { nodes: [manga] } });
    if (query.includes('RefreshManga')) return json({ fetchMangaAndChapters: { manga, chapters } });
    if (query.includes('ChapterPages')) return json({ fetchChapterPages: { pages: ['/api/v1/manga/41/chapter/51/page/0'] } });
    throw new Error('Unexpected GraphQL operation');
  });
  return { requests, fetch };
}

it('resolves imports using exact source IDs and URLs and retains imported chapter identities', async () => {
  const { requests } = mockServer();
  await putManga({ id: manga.url, sourceId: id, title: manga.title, description: '', genres: [], coverUrl: '', status: 'Ongoing' });
  await putChapterMetas(id, manga.url, [{ id: 'https://source.example/chapter/2', url: '/chapter/2', mangaId: manga.url, name: 'Imported chapter', number: 2, dateUpload: 0 }]);
  await connectSuwayomi('/api/suwayomi');
  const source = getSource(id)!;
  expect(await source.getChapterList(manga.url)).toMatchObject([{ id: 'https://source.example/chapter/2', backendId: 51, dateUpload: 1794000000000 }]);
  expect(await source.getPageList('https://source.example/chapter/2', manga.url)).toEqual([{ imageUrl: '/api/suwayomi/api/v1/manga/41/chapter/51/page/0' }]);
  const resolve = requests.find(r => r.query.includes('ResolveManga'))!;
  expect(resolve.variables).toEqual({ condition: { sourceId: id, url: manga.url } });
  expect(resolve.query).toContain('$condition: MangaConditionInput!');
  expect(requests.find(r => r.query.includes('ChapterPages'))?.variables).toEqual({ input: { chapterId: 51 } });
});

it('discards backend manga bindings when the configured server changes', async () => {
  const { requests } = mockServer();
  await connectSuwayomi(base);
  await getSource(id)!.getMangaDetails(manga.url);
  await connectSuwayomi('https://replacement.example');
  await getSource(id)!.getMangaDetails(manga.url);
  expect(requests.filter(r => r.query.includes('ResolveManga')).map(r => r.url)).toEqual([base + '/api/graphql', 'https://replacement.example/api/graphql']);
  expect((await (await getDB()).get('backendBindings', id + '::' + manga.url))?.server).toBe('https://replacement.example');
});

it('revalidates a persisted backend ID after a database is replaced at the same URL', async () => {
  const { requests } = mockServer();
  await (await getDB()).put('backendBindings', { key: id + '::' + manga.url, server: base, mangaId: 999 });
  await connectSuwayomi(base);
  const result = await getSource(id)!.getMangaDetails(manga.url);
  expect(requests.find(r => r.query.includes('ResolveManga'))?.variables).toEqual({ condition: { sourceId: id, url: manga.url } });
  expect(requests.find(r => r.query.includes('RefreshManga'))?.variables.input.id).toBe(41);
  expect(result.coverUrl).toBe(base + '/api/v1/manga/41/thumbnail#' + encodeURIComponent(id + '::' + manga.url));
});

it('keeps a slow previous connection from replacing the newly selected server', async () => {
  let release!: (response: Response) => void;
  const first = new Promise<Response>(resolve => { release = resolve; });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).startsWith(base) ? first : json({ sources: { nodes: [{ ...info, name: 'Replacement' }], totalCount: 1 } }));
  const pending = connectSuwayomi(base);
  await connectSuwayomi('https://replacement.example');
  release(json({ sources: { nodes: [info], totalCount: 1 } }));
  await pending;
  expect(getConnectionSnapshot()).toMatchObject({ url: 'https://replacement.example', status: 'connected' });
  expect(getSource(id)?.name).toBe('Replacement');
});

it('cancels a download during source resolution before the page request', async () => {
  const cancel = vi.fn();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { query } = JSON.parse(String(init?.body));
    if (query.includes('query Sources')) return json({ sources: { nodes: [info], totalCount: 1 } });
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"data":')); }, cancel }));
  });
  await connectSuwayomi(base);
  const controller = new AbortController();
  const pages = getSource(id)!.getPageList('/chapter/2', manga.url, controller.signal);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  controller.abort();
  await expect(pages).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledOnce();
});

it('uploads the original backup with flags accepted by stable Suwayomi and polls its restore status', async () => {
  const original = new Blob(['synthetic backup bytes']);
  const requests: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.body instanceof FormData) {
      expect(await (init.body.get('0') as File).text()).toBe(await original.text());
      expect(JSON.parse(String(init.body.get('map')))).toEqual({ '0': ['variables.backup'] });
      const operation = JSON.parse(String(init.body.get('operations')));
      requests.push(operation);
      return json({ restoreBackup: { id: 'restore-1' } });
    }
    const operation = JSON.parse(String(init?.body));
    requests.push(operation);
    return operation.query.includes('RestoreStatus') ? json({ restoreStatus: { state: 'SUCCESS', mangaProgress: 1, totalManga: 1 } }) : json({ sources: { nodes: [info], totalCount: 1 } });
  });
  await connectSuwayomi(base);
  await sendBackupToServer({ id: 'fixture', name: 'fixture.tachibk', bytes: original, importedAt: 0, mangaCount: 1, chapterCount: 1 });
  expect(requests.find(r => r.query.includes('RestoreBackup')).variables.flags).toEqual({ includeManga: true, includeChapters: true, includeCategories: true, includeTracking: true, includeHistory: true, includeClientData: false, includeServerSettings: false });
  expect(requests.find(r => r.query.includes('RestoreStatus')).variables).toEqual({ id: 'restore-1' });
});
