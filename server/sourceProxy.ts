import type { IncomingMessage, ServerResponse } from 'node:http';
import { backupSourceConfigs, allowedSourceUrl } from '../src/sources/backupSources.ts';
import { proxyError, proxyRequestScope, sendResponse } from './proxy.ts';
import { returnedHubAccessKey, validHubAccessKey } from '../src/sources/mangahubAccess.ts';
import { browserCall } from './browserBridge.ts';

export async function handleSourceProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const incoming = new URL(req.url ?? '', 'http://localhost');
  const config = backupSourceConfigs.find(source => source.id === incoming.searchParams.get('source'));
  if (!config) { proxyError(res, 400, 'Unknown built-in source'); return; }
  let target: URL;
  try { target = new URL(incoming.searchParams.get('url') ?? ''); }
  catch { proxyError(res, 400, 'Invalid source URL'); return; }
  const image = incoming.searchParams.get('image') === '1';
  if (!allowedSourceUrl(config, target, image)) { proxyError(res, 403, 'Source host not allowed'); return; }
  const refresh = incoming.searchParams.get('refresh') === '1';
  if (refresh && (image || req.method !== 'GET' || config.name !== 'MangaHub' || target.hostname !== 'mangahub.io' || !/^\/(?:manga\/[^/]+|chapter\/[^/]+\/chapter-\d+(?:\.\d+)?)\/?$/.test(target.pathname))) { proxyError(res, 400, 'Invalid source session refresh'); return; }
  const graphQL = config.name === 'MangaHub' && target.hostname === 'api.mghcdn.com' && target.pathname === '/graphql';
  const chapterAjax = config.name === 'Kissmanga.in' && /^\/kissmanga\/[^/]+\/ajax\/chapters\/?$/.test(target.pathname);
  if (req.method !== 'GET' && !(req.method === 'POST' && !image && (graphQL || chapterAjax))) { proxyError(res, 405, 'Method not allowed'); return; }
  const scope = proxyRequestScope(req, res, 60000);
  try {
    let body: string | undefined;
    const xhr = graphQL || target.pathname.startsWith('/api/');
    const headers = new Headers({ Accept: image ? 'image/*' : xhr ? 'application/json' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: config.baseUrl + '/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.5' });
    if (config.name === 'MangaFox') headers.set('Cookie', 'readway=2; isAdult=1');
    if (config.name === 'MangaHub') {
      const key = req.headers['x-mhub-access'];
      if (validHubAccessKey(key)) { headers.set('x-mhub-access', key); headers.set('Cookie', `mhub_access=${key}`); }
      headers.set('DNT', '1');
      if (graphQL) headers.set('Origin', config.baseUrl);
      if (refresh) headers.set('Referer', config.baseUrl + '/manga/' + target.pathname.split('/')[2]);
    }
    if (graphQL) {
      headers.set('Content-Type', 'application/json');
      // Small public read-only queries; never forward arbitrary upload bodies.
      const prepared = (req as IncomingMessage & { body?: unknown }).body;
      if (prepared !== undefined) body = typeof prepared === 'string' ? prepared : Buffer.isBuffer(prepared) ? prepared.toString() : JSON.stringify(prepared);
      else {
        body = '';
        for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 16384) throw new RangeError('Source query too large'); }
      }
      if (Buffer.byteLength(body ?? '') > 16384) throw new RangeError('Source query too large');
      const parsed = JSON.parse(body!);
      if (typeof parsed.query !== 'string' || !parsed.query.trim().startsWith('{') || Object.keys(parsed).some(key => key !== 'query')) { proxyError(res, 400, 'Only source reading queries are supported'); return; }
    }
    if (incoming.searchParams.get('browser') === '1') {
      const response = await browserCall(req, res, '/request', { source: config.id, url: target.href, image, refresh, method: req.method, body, key: req.headers['x-mhub-access'] });
      if (!response) return;
      const result = await response.json() as { status: number; contentType?: string; body?: string; accessKey?: string; error?: string; requiresVerification?: boolean };
      if (!response.ok || result.error) { proxyError(res, response.ok ? result.status || 502 : response.status, result.error ?? 'Browser source request failed'); return; }
      if (validHubAccessKey(result.accessKey)) res.setHeader('X-Mhub-Access', result.accessKey);
      res.statusCode = result.status;
      res.setHeader('Content-Type', result.contentType ?? 'application/octet-stream');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(result.body ?? '', 'base64')); return;
    }
    for (let redirects = 0; redirects < 5; redirects++) {
      if (!allowedSourceUrl(config, target, image)) { proxyError(res, 403, 'Source redirect host not allowed'); return; }
      const response = await fetch(target, { method: req.method, body, headers, signal: scope.signal, redirect: 'manual' });
      const key = config.name === 'MangaHub' ? returnedHubAccessKey(response.headers) : undefined;
      if (key) res.setHeader('X-Mhub-Access', key);
      if (refresh) {
        // Mihon reads the original page's cookie, including on licensed-title
        // redirects. Never follow that redirect or relay source page scripts.
        await response.body?.cancel();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ refreshed: !!key, upstreamStatus: response.status }));
        return;
      }
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        target = new URL(response.headers.get('location')!, target);
        await response.body?.cancel();
        // POST source APIs do not legitimately redirect to different routes.
        if (req.method === 'POST') { proxyError(res, 502, 'The source API has moved'); return; }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        proxyError(res, response.status, response.status === 403 ? `${config.name} is blocking app requests. Try again later or open the source website.` : `${config.name} request failed (HTTP ${response.status}).`);
        return;
      }
      // Source HTML/SVG must never become executable same-origin documents
      // if the proxy URL is opened in a tab instead of fetched by an adapter.
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Cache-Control', image ? 'public, max-age=86400' : 'no-store');
      await sendResponse(response, res);
      return;
    }
    proxyError(res, 502, 'Too many source redirects');
  } catch (error) {
    proxyError(res, error instanceof RangeError ? 413 : 502, error instanceof RangeError ? error.message : `${config.name} is currently unreachable. Try again later or open the source website.`);
  } finally { scope.cleanup(); }
}
