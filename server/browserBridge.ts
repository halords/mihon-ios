import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { proxyError, proxyRequestScope } from './proxy.ts';

const cookieName = 'mihon-browser-session';
function config(): { url: URL; token: string } | undefined {
  if (!process.env.SOURCE_BROWSER_URL || !process.env.SOURCE_BROWSER_TOKEN) return;
  const url = new URL(process.env.SOURCE_BROWSER_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid browser backend URL');
  return { url, token: process.env.SOURCE_BROWSER_TOKEN };
}
function session(req: IncomingMessage, res: ServerResponse): string {
  const existing = /(?:^|;\s*)mihon-browser-session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
  if (existing) return existing;
  const value = randomBytes(32).toString('hex');
  const secure = req.headers['x-forwarded-proto'] === 'https' || !!(req.socket as { encrypted?: boolean }).encrypted;
  res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`);
  return value;
}
export async function browserCall(req: IncomingMessage, res: ServerResponse, path: string, body?: unknown): Promise<Response | undefined> {
  const backend = config();
  if (!backend) { proxyError(res, 503, 'Browser verification is not configured on this app host. See browser backend setup in Connections.'); return; }
  const scope = proxyRequestScope(req, res, 60000);
  try {
    const response = await fetch(new URL(path, backend.url), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${backend.token}`, 'X-Mihon-Browser-Session': session(req, res), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: scope.signal, redirect: 'error' });
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('Browser response too large'); } chunks.push(result.value); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  } catch { proxyError(res, 502, 'Browser backend is unavailable. Check its service on your VPS.'); return; }
  finally { scope.cleanup(); }
}
export async function handleBrowserSessionProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) { proxyError(res, 403, 'Cross-origin browser controls are not allowed'); return; }
  if (url.searchParams.get('status') === '1') {
    if (req.method !== 'GET') { proxyError(res, 405, 'Method not allowed'); return; }
    if (!config()) { res.setHeader('Content-Type', 'application/json'); res.end('{"configured":false}'); return; }
    const response = await browserCall(req, res, '/health');
    if (!response) return;
    res.statusCode = response.status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    res.end(await response.text()); return;
  }
  if (!['GET', 'POST'].includes(req.method ?? '')) { proxyError(res, 405, 'Method not allowed'); return; }
  let body: unknown;
  try {
    if (req.method === 'POST') {
      const prepared = (req as IncomingMessage & { body?: unknown }).body;
      if (prepared !== undefined) body = typeof prepared === 'string' || Buffer.isBuffer(prepared) ? JSON.parse(prepared.toString()) : prepared;
      else { let raw = ''; for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 2048) throw new Error('Control too large'); } body = JSON.parse(raw); }
      if (Buffer.byteLength(JSON.stringify(body)) > 2048) throw new Error('Control too large');
    }
    const response = await browserCall(req, res, '/session?source=' + encodeURIComponent(url.searchParams.get('source') ?? ''), body);
    if (!response) return;
    res.statusCode = response.status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    res.end(await response.text());
  } catch { proxyError(res, 400, 'Invalid browser control'); }
}
