import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { BrowserSessions } from '../browser-server/sessions.mjs';
import { createBrowserService } from '../browser-server/index.mjs';
import { handleSourceProxy } from '../server/sourceProxy';
import { handleBrowserSessionProxy } from '../server/browserBridge';

it('keeps a user-operated browser session for source APIs, cross-origin images, idle restore and isolated visitors', async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'mihon-browser-test-'));
  const launches: unknown[] = [];
  class FixtureSessions extends BrowserSessions {
    async createVisitor(key: string) {
      const visitor = await super.createVisitor(key);
      await visitor.context.route('**/*', async (route: import('playwright').Route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'api.mghcdn.com') {
        const allowed = route.request().headers()['x-mhub-access'] === 'verified-key';
        await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'https://mangahub.io', 'Access-Control-Allow-Headers': 'content-type,x-mhub-access' }, body: JSON.stringify(allowed ? { data: { search: { rows: [{ title: 'Verified Hero' }] } } } : { errors: [{ message: 'API key invalid' }] }) });
      } else if (url.hostname === 'imgx.mghcdn.com') {
        // No CORS grant: image bytes must come from a browser image request.
        await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64') });
      } else await route.fulfill({ contentType: 'text/html', body: '<html><head><title>Source session fixture</title></head><body style="margin:0"><button style="width:200px;height:80px" onclick="document.cookie=\'mhub_access=verified-key; path=/\';this.textContent=\'Session ready\'">Approve fixture session</button></body></html>' });
      });
      return visitor;
    }
  }
  // The test verifies session/proxy behavior, not Chromium sandboxing — and
  // the sandbox cannot initialize in containers/CI (launch dies with
  // "Chromium sandboxing failed!"), which was the whole failure. Override
  // the sandbox flag in the injected launch only; production still launches
  // sandboxed on Linux (sessions.mjs). The recorded options stay untouched.
  const sessions = new FixtureSessions({ stateDir, idleMs: 60000, launch: async (options: Parameters<typeof chromium.launch>[0]) => { launches.push(options); return chromium.launch({ ...options, chromiumSandbox: false }); } });
  const service = createBrowserService({ token: 'test-browser-secret-'.repeat(3), sessions });
  await new Promise<void>(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const backend = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  const previousUrl = process.env.SOURCE_BROWSER_URL, previousToken = process.env.SOURCE_BROWSER_TOKEN;
  process.env.SOURCE_BROWSER_URL = backend; process.env.SOURCE_BROWSER_TOKEN = 'test-browser-secret-'.repeat(3);
  const proxy = createServer((req, res) => void (req.url?.startsWith('/api/source-browser') ? handleBrowserSessionProxy(req, res) : handleSourceProxy(req, res)));
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const source = '4758858684982406533';
  try {
    expect((await fetch(backend + '/health')).status).toBe(401);
    const snapshot = await fetch(origin + `/api/source-browser?source=${source}`);
    const cookie = snapshot.headers.get('set-cookie')!.split(';')[0];
    expect(snapshot.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await snapshot.json()).toMatchObject({ title: 'Source session fixture', width: 390 });
    const api = origin + '/api/source?' + new URLSearchParams({ source, url: 'https://api.mghcdn.com/graphql', browser: '1' });
    const request = () => fetch(api, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Mhub-Access': 'stale-key' }, body: JSON.stringify({ query: '{search{rows{title}}}' }) });
    expect(await (await request()).json()).toMatchObject({ errors: [{ message: 'API key invalid' }] });
    const click = await fetch(origin + `/api/source-browser?source=${source}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'click', x: 100, y: 40 }) });
    expect(click.status).toBe(200);
    const data = await request();
    expect(data.headers.get('x-mhub-access')).toBe('verified-key');
    expect(await data.json()).toMatchObject({ data: { search: { rows: [{ title: 'Verified Hero' }] } } });
    const image = await fetch(origin + '/api/source?' + new URLSearchParams({ source, url: 'https://imgx.mghcdn.com/page.png', image: '1', browser: '1' }), { headers: { Cookie: cookie } });
    expect(image.headers.get('content-type')).toBe('image/png');
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(50);
    await sessions.releaseIdle(true);
    expect(await (await request()).json()).toMatchObject({ data: { search: { rows: [{ title: 'Verified Hero' }] } } });
    expect(launches).toHaveLength(2);
    const other = await fetch(api, { method: 'POST', body: JSON.stringify({ query: '{search{rows{title}}}' }) });
    expect(await other.json()).toMatchObject({ errors: [{ message: 'API key invalid' }] });
    expect((await fetch(origin + '/api/source-browser?source=' + source, { method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(origin + '/api/source?' + new URLSearchParams({ source, url: 'https://127.0.0.1/private', browser: '1' }))).status).toBe(403);
  } finally {
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await service.close();
    if (previousUrl === undefined) delete process.env.SOURCE_BROWSER_URL; else process.env.SOURCE_BROWSER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.SOURCE_BROWSER_TOKEN; else process.env.SOURCE_BROWSER_TOKEN = previousToken;
    if (stateDir.startsWith(resolve(tmpdir()) + sep)) await rm(stateDir, { recursive: true, force: true });
  }
}, 45000);
