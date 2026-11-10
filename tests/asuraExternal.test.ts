import { expect, it, vi } from 'vitest';
import { asuraSource } from '../src/sources/asuraSource';

vi.mock('../src/sources/sourceUtils', async importOriginal => {
  const original = await importOriginal<typeof import('../src/sources/sourceUtils')>();
  return { ...original, sourceDocument: async () => ({ querySelectorAll: () => [{ getAttribute: () => JSON.stringify({
    publicUrl: [0, '/comics/locked-test-abcdefgh'], seriesSlug: [0, 'locked-test'],
    chapters: [1, [[0, { number: [0, 2], is_premium: [0, true] }], [0, { number: [0, 1] }]]],
  }) }] }) };
});
it('preserves native Asura chapter identities and links subscription chapters to their real Asura page', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ slug: 'locked-test', title: 'Locked test', public_url: '/comics/locked-test-abcdefgh' }] })));
  const chapters = await asuraSource.getChapterList('/series/locked-test');
  expect(chapters[0]).toMatchObject({ id: '/series/locked-test/chapter/2', external: true, externalUrl: 'https://asurascans.com/comics/locked-test-abcdefgh/chapter/2' });
  expect(chapters[1].external).toBeUndefined();
  expect(chapters[1].externalUrl).toBeUndefined();
});
