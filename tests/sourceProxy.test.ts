import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { handleSourceProxy } from '../server/sourceProxy';

async function request(params: Record<string, string>, init?: RequestInit) {
  const nativeFetch = globalThis.fetch;
  const upstream = vi.spyOn(globalThis, 'fetch');
  const server = createServer((req, res) => void handleSourceProxy(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/source?${new URLSearchParams(params)}`;
  return { upstream, async fetch() { return nativeFetch(url, init); }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
it('rejects unknown sources, non-source URLs and arbitrary POST routes before contacting upstream', async () => {
  for (const [params, method, code] of [
    [{ source: 'unknown', url: 'https://api.mghcdn.com/graphql' }, 'GET', 400],
    [{ source: '4758858684982406533', url: 'https://127.0.0.1/private' }, 'GET', 403],
    [{ source: '4758858684982406533', url: 'https://mangahub.io/login' }, 'POST', 405],
    [{ source: '4758858684982406533', url: 'https://imgx.mghcdn.com/test.jpg', image: '1' }, 'POST', 405],
  ] as const) {
    const check = await request(params, { method });
    try { expect((await check.fetch()).status).toBe(code); expect(check.upstream).not.toHaveBeenCalled(); }
    finally { check.upstream.mockRestore(); await check.close(); }
  }
});
it('forwards only read-only MangaHub queries and its scoped public access key', async () => {
  const check = await request({ source: '4758858684982406533', url: 'https://api.mghcdn.com/graphql' }, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mhub-Access': 'a'.repeat(32), Authorization: 'secret', Cookie: 'private=session' }, body: JSON.stringify({ query: '{search(q:"mutation"){rows{slug}}}' }) });
  check.upstream.mockResolvedValue(new Response('{"data":{"search":{"rows":[]}}}', { headers: { 'Content-Type': 'application/json' } }));
  try {
    const response = await check.fetch(); expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(await response.json()).toEqual({ data: { search: { rows: [] } } });
    const headers = check.upstream.mock.calls[0][1]!.headers as Headers;
    expect(headers.get('x-mhub-access')).toBe('a'.repeat(32));
    expect(headers.get('cookie')).toBe('mhub_access=' + 'a'.repeat(32));
    expect(headers.has('authorization')).toBe(false);
  } finally { await check.close(); }
});
it('rejects mutations and prevents redirects to unapproved domains', async () => {
  const mutation = await request({ source: '4758858684982406533', url: 'https://api.mghcdn.com/graphql' }, { method: 'POST', body: JSON.stringify({ query: 'mutation {changeUser}' }) });
  try { expect((await mutation.fetch()).status).toBe(400); expect(mutation.upstream).not.toHaveBeenCalled(); }
  finally { mutation.upstream.mockRestore(); await mutation.close(); }
  const redirect = await request({ source: '6484561431658238800', url: 'https://fanfox.net/directory/' });
  redirect.upstream.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }));
  try { expect((await redirect.fetch()).status).toBe(403); expect(redirect.upstream).toHaveBeenCalledOnce(); }
  finally { await redirect.close(); }
});
it('returns a clear source error when upstream denies app access', async () => {
  const check = await request({ source: '4758858684982406533', url: 'https://mangahub.io/' });
  check.upstream.mockResolvedValue(new Response('challenge html', { status: 403 }));
  try { const response = await check.fetch(); expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: expect.stringContaining('blocking app requests') }); }
  finally { await check.close(); }
});
