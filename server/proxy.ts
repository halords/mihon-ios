import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function isAllowedMangaDexUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
    (url.hostname === 'mangadex.org' || url.hostname.endsWith('.mangadex.org') ||
     url.hostname === 'mangadex.network' || url.hostname.endsWith('.mangadex.network'));
}

export async function fetchMangaDex(url: URL, signal: AbortSignal): Promise<Response> {
  let target = url;
  for (let redirects = 0; redirects < 5; redirects++) {
    if (!isAllowedMangaDexUrl(target)) throw new Error('Host not allowed');
    const response = await fetch(target, {
      redirect: 'manual', signal,
      headers: { Accept: 'application/json,image/*;q=0.9,*/*;q=0.8', Referer: 'https://mangadex.org/' },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      const next = new URL(response.headers.get('location')!, target);
      await response.body?.cancel();
      target = next;
      continue;
    }
    return response;
  }
  throw new Error('Too many source redirects');
}

export function backendCookies(headers: Headers): string[] {
  return headers.getSetCookie().map(cookie => {
    const scoped = cookie.replace(/;\s*Domain=[^;]*/ig, '').replace(/;\s*Path=[^;]*/i, '; Path=/api/suwayomi/');
    return /;\s*Path=/i.test(scoped) ? scoped : `${scoped}; Path=/api/suwayomi/`;
  });
}

export async function sendResponse(response: Response, res: ServerResponse, includeBackendCookies = false): Promise<void> {
  res.statusCode = response.status;
  for (const name of ['content-type', 'content-length', 'retry-after', 'etag', 'last-modified']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  // fetch transparently decompresses responses; upstream content-length
  // can then describe compressed bytes, so let Node calculate the length.
  res.removeHeader('content-length');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (includeBackendCookies) {
    const cookies = backendCookies(response.headers);
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
  }
  if (!response.body) { res.end(); return; }
  // Pipeline respects backpressure and closes the upstream body as soon as
  // the browser cancels a download.
  const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
  // Native fetch cancellation may emit a late error after pipeline has
  // detached its listeners. Active errors are still handled by pipeline.
  stream.on('error', () => {});
  await pipeline(stream, res);
}

export function proxyError(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: message }));
}

export function proxyRequestScope(req: IncomingMessage, res: ServerResponse, timeout: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
  const close = () => { if (!res.writableFinished) abort(); };
  const timer = setTimeout(() => controller.abort(new DOMException('Upstream timed out', 'TimeoutError')), timeout);
  timer.unref();
  req.once('aborted', abort);
  res.once('close', close);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    },
  };
}

export async function readProxyBody(req: IncomingMessage): Promise<Buffer> {
  const limit = 128 * 1024 * 1024;
  const request = req as IncomingMessage & { body?: unknown; rawBody?: unknown };
  const prepared = request.rawBody ?? request.body;
  let body: Buffer;
  // Serverless runtimes may consume the stream and provide a body helper.
  // Keep multipart bytes intact; JSON variables include exact string IDs.
  if (Buffer.isBuffer(prepared)) body = prepared;
  else if (prepared instanceof Uint8Array) body = Buffer.from(prepared);
  else if (typeof prepared === 'string') body = Buffer.from(prepared);
  else if (prepared !== undefined && /^application\/json\b/i.test(req.headers['content-type'] ?? '')) body = Buffer.from(JSON.stringify(prepared));
  else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new RangeError('Backup exceeds 128 MB');
      chunks.push(Buffer.from(chunk));
    }
    body = Buffer.concat(chunks);
  }
  if (body.length > limit) throw new RangeError('Backup exceeds 128 MB');
  return body;
}

export async function handleMangaDexProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') { proxyError(res, 405, 'Method not allowed'); return; }
  const input = new URL(req.url ?? '', 'http://localhost').searchParams.get('url');
  let target: URL;
  try { target = new URL(input ?? ''); }
  catch { proxyError(res, 400, 'Invalid or missing URL'); return; }
  if (!isAllowedMangaDexUrl(target)) { proxyError(res, 403, 'Host not allowed'); return; }
  const scope = proxyRequestScope(req, res, 60000);
  try {
    const response = await fetchMangaDex(target, scope.signal);
    res.setHeader('Cache-Control', response.ok ? target.hostname === 'api.mangadex.org' ? 'public, max-age=30' : 'public, max-age=86400' : 'no-store');
    await sendResponse(response, res);
  } catch { proxyError(res, 502, 'MangaDex is currently unreachable. Try again shortly.'); }
  finally { scope.cleanup(); }
}

export async function handleSuwayomiProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = process.env.SUWAYOMI_URL;
  if (!server) { proxyError(res, 503, 'Set SUWAYOMI_URL on the server, or enter your Suwayomi HTTPS URL in Connections.'); return; }
  const incoming = new URL(req.url ?? '', 'http://localhost');
  const path = incoming.searchParams.get('path') ?? incoming.pathname.replace(/^\/api\/suwayomi\/?/, '');
  if (!/^api\/(?:graphql(?:\/files\/[^?]*)?|v1\/(?:manga|chapter|extension)\/[^?]*)$/.test(path) || path.includes('..') || path.includes('\\')) {
    proxyError(res, 403, 'Backend route not allowed'); return;
  }
  if (req.method !== 'GET' && !(req.method === 'POST' && path === 'api/graphql')) { proxyError(res, 405, 'Method not allowed'); return; }
  const target = new URL(`${server.replace(/\/+$/, '')}/${path}`);
  for (const [key, value] of incoming.searchParams) if (key !== 'path') target.searchParams.append(key, value);
  const headers = new Headers();
  for (const key of ['accept', 'content-type', 'authorization', 'cookie']) {
    const value = req.headers[key];
    if (typeof value === 'string') headers.set(key, value);
  }
  const scope = proxyRequestScope(req, res, 120000);
  try {
    let body: Buffer | undefined;
    if (req.method === 'POST') body = await readProxyBody(req);
    const response = await fetch(target, { method: req.method, headers, body, signal: scope.signal, redirect: 'manual' });
    res.setHeader('Cache-Control', 'no-store');
    await sendResponse(response, res, true);
  } catch (error) { proxyError(res, error instanceof RangeError ? 413 : 502, error instanceof RangeError ? error.message : 'Unable to connect to the configured Suwayomi server'); }
  finally { scope.cleanup(); }
}
