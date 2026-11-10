import { expect, it, vi } from 'vitest';
import { MangaHubSession } from '../src/sources/mangahubSource';
import { normalizeBoxSearch } from '../src/sources/htmlSources';

const json = (value: unknown, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { headers });
it('uses MangaBox website search aliases for accented titles and punctuation', () => {
  expect(normalizeBoxSearch('  ĐấU: Héro’s (Return) - 2! ')).toBe('dau_hero’s_return_2');
  expect(normalizeBoxSearch("The Hero's Return: Part 2")).toBe('the_hero_s_return_part_2');
  expect(normalizeBoxSearch(' __-- ')).toBe('');
});
it('refreshes a rejected MangaHub key on the actual title page and retries with its returned cookie', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'https://reader.example');
    if (url.searchParams.get('refresh') === '1') return json({ refreshed: true }, { 'X-Mhub-Access': 'returned.access-key' });
    const headers = new Headers(init?.headers);
    return headers.get('X-Mhub-Access') === 'returned.access-key' ? json({ data: { title: 'Hero' } }) : json({ errors: [{ message: 'API key invalid' }] });
  });
  const session = new MangaHubSession();
  expect(await session.query('{manga{title}}', undefined, 'https://mangahub.io/manga/hero')).toEqual({ title: 'Hero' });
  expect(fetch).toHaveBeenCalledTimes(3);
  const refresh = new URL(String(fetch.mock.calls[1][0]), 'https://reader.example');
  expect(refresh.searchParams.get('url')).toBe('https://mangahub.io/manga/hero?reloadKey=1');
  expect(sessionStorage.getItem('mihon-mangahub-access')).toBe('returned.access-key');
  await new MangaHubSession().query('{manga{title}}');
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('shares refresh requests between concurrent queries and does not lose either result', async () => {
  let refreshes = 0;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (new URL(String(input), 'https://reader.example').searchParams.get('refresh') === '1') {
      refreshes++; await new Promise(resolve => setTimeout(resolve, 20));
      return json({ refreshed: true }, { 'X-Mhub-Access': 'shared-key' });
    }
    return new Headers(init?.headers).get('X-Mhub-Access') === 'shared-key' ? json({ data: { ok: true } }) : new Response('{"error":"Blocked"}', { status: 403 });
  });
  const session = new MangaHubSession();
  expect(await Promise.all([session.query('{manga{title}}'), session.query('{chapter{pages}}')])).toEqual([{ ok: true }, { ok: true }]);
  expect(refreshes).toBe(1); expect(fetch).toHaveBeenCalledTimes(5);
});
it('makes only two page refreshes and one fresh-key fallback if MangaHub continues to deny access', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    return new URL(String(input), 'https://reader.example').searchParams.has('refresh') ? json({ refreshed: false, upstreamStatus: 403 }) : new Response('{"error":"MangaHub is blocking app requests"}', { status: 403 });
  });
  await expect(new MangaHubSession().query('{search{rows{title}}}')).rejects.toThrow('blocking app requests');
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('does not refresh unrelated GraphQL failures or cancelled requests', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ errors: [{ message: 'Title unavailable' }] }));
  await expect(new MangaHubSession().query('{manga{title}}')).rejects.toThrow('Title unavailable');
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockClear().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  await expect(new MangaHubSession().query('{manga{title}}')).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledOnce();
});
