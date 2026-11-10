import { expect, it, vi } from 'vitest';
import { getSource, sources } from '../src/sources';
import { backupSourceConfig, allowedSourceUrl } from '../src/sources/backupSources';
import { decryptHubPages, hubPagePaths, mangahubSource } from '../src/sources/mangahubSource';
import { currentChapterUrl, retainChapterIds } from '../src/sources/sourceUtils';
import { chapterKey, mangaKey } from '../src/sources/Source';
import { getChapterState, putChapterMetas, patchChapterState } from '../src/lib/db';
import { cdnUrl } from '../src/lib/fetchJson';

it('includes only the backup source identities by default, with both Manhwa18 IDs and no sample catalog', () => {
  expect(sources.filter(source => source.kind === 'builtin').map(source => source.id).sort()).toEqual(['mangadex', '4758858684982406533', '2528986671771677900', '993336618407081332', '4841602236575491202', '6247824327199706550', '7798162483793432927', '6484561431658238800', '3112384885023225761'].sort());
  expect(getSource('sample')).toBeUndefined();
});
it('preserves imported chapter keys, marks, bookmarks and refreshed URLs within the same source title', async () => {
  const config = backupSourceConfig('993336618407081332');
  const id = '/webtoon/fixture', old = 'https://manhwa18.cc/webtoon/fixture/chapter-10?style=list';
  await putChapterMetas(config.id, id, [{ id: old, url: old, mangaId: id, name: 'Chapter 10', number: 10, dateUpload: 0 }]);
  const key = chapterKey(config.id, id, old);
  await patchChapterState(key, mangaKey(config.id, id), { read: true, bookmark: true, lastPage: 7 });
  const chapters = await retainChapterIds(config, id, [{ id: '/webtoon/fixture/chapter-10', url: '/webtoon/fixture/chapter-10', mangaId: id, name: 'Chapter 10', number: 10, dateUpload: 1 }]);
  await putChapterMetas(config.id, id, chapters);
  expect(chapters[0].id).toBe(old);
  expect(await currentChapterUrl(config, old, id)).toBe('/webtoon/fixture/chapter-10');
  expect(await getChapterState(key)).toMatchObject({ read: true, bookmark: true, lastPage: 7 });
});
it('does not attach progress by chapter number when releases are ambiguous', async () => {
  const config = backupSourceConfig('2528986671771677900'), id = '/manga/fixture';
  await putChapterMetas(config.id, id, ['release-a','release-b'].map(name => ({ id: name, mangaId: id, name, number: 1, dateUpload: 0 })));
  const incoming = [{ id: 'new-release', mangaId: id, name: 'Chapter 1', number: 1, dateUpload: 1 }];
  expect(await retainChapterIds(config, id, incoming)).toEqual(incoming);
});
it('does not select a duplicate normalized URL arbitrarily', async () => {
  const config = backupSourceConfig('993336618407081332'), id = '/webtoon/fixture';
  await putChapterMetas(config.id, id, ['/chapter-1?style=list', 'https://manhwa18.cc/chapter-1'].map(url => ({ id: url, url, mangaId: id, name: 'Chapter 1', number: 1, dateUpload: 0 })));
  const incoming = [{ id: 'new-key', url: '/chapter-1', mangaId: id, name: 'Chapter 1', number: 1, dateUpload: 1 }];
  expect(await retainChapterIds(config, id, incoming)).toEqual(incoming);
});
it('keeps source requests and images on approved HTTPS hosts, including CDN routing without double proxying', () => {
  const config = backupSourceConfig('4758858684982406533');
  expect(allowedSourceUrl(config, new URL('https://api.mghcdn.com/graphql'))).toBe(true);
  expect(allowedSourceUrl(config, new URL('https://imgx.mghcdn.com/chapter/1'), true)).toBe(true);
  for (const url of ['https://mghcdn.com.attacker.test', 'https://user:pass@api.mghcdn.com', 'http://api.mghcdn.com', 'https://api.mghcdn.com:8000', 'https://127.0.0.1']) expect(allowedSourceUrl(config, new URL(url), true)).toBe(false);
  const url = cdnUrl('https://thumb.mghcdn.com/cover.jpg');
  expect(url).toContain('/api/source?source=4758858684982406533');
  expect(cdnUrl(url)).toBe(url);
});
it('uses escaped MangaHub search text and exact native URLs and exposes source access failures', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { search: { rows: [{ slug: 'fixture', title: 'Fixture', image: 'fixture.jpg' }] } } })));
  const result = await mangahubSource.searchManga('title"} mutation {', 2);
  expect(result[0]).toMatchObject({ id: '/manga/fixture', sourceId: '4758858684982406533', url: '/manga/fixture' });
  const body = JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);
  expect(body.query).toContain('q:"title\\"} mutation {"');
  expect(body.query).toContain('offset:30');
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'MangaHub is blocking app requests.' }), { status: 403 }));
  await expect(mangahubSource.getPopularManga(1)).rejects.toThrow('blocking app requests');
});
it('decodes the public MangaHub AES-GCM page format and verifies its authentication tag', async () => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plaintext = '{"p":"fixture/","i":["1.jpg","2.jpg"]}';
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64url');
  const value = `enc:v1:test:${base64(iv)}:${base64(encrypted.slice(-16))}:${base64(encrypted.slice(0,-16))}`;
  expect(hubPagePaths(await decryptHubPages(value, { keys: { test: base64(keyBytes) } }))).toEqual(['fixture/1.jpg','fixture/2.jpg']);
  await expect(decryptHubPages(value, { key: base64(new Uint8Array(32)) })).rejects.toThrow('decoding failed');
});
