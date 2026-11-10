import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BrowserSessions, sessionPattern } from './sessions.mjs';

export function createBrowserService({ token = process.env.SOURCE_BROWSER_TOKEN, sessions = new BrowserSessions() } = {}) {
  if (!token || token.length < 32) throw new Error('Set SOURCE_BROWSER_TOKEN to a random value of at least 32 characters');
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    const received = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { res.statusCode = 401; res.end('{"error":"Unauthorized browser service"}'); return; }
    const key = req.headers['x-mihon-browser-session'];
    if (typeof key !== 'string' || !sessionPattern.test(key)) { res.statusCode = 400; res.end('{"error":"Invalid browser session"}'); return; }
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') { res.end('{"configured":true}'); return; }
      let body;
      if (req.method === 'POST') { let raw = ''; for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 20000) throw new Error('Request too large'); } body = JSON.parse(raw); }
      let result;
      if (url.pathname === '/request' && req.method === 'POST') result = await sessions.request(key, body);
      else if (url.pathname === '/session' && ['GET', 'POST'].includes(req.method)) result = await sessions.snapshot(key, url.searchParams.get('source'), body);
      else { res.statusCode = 404; result = { error: 'Unknown browser service route' }; }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = /Invalid|Unknown|not allowed|too large|Only source/.test(error.message) ? 400 : 502;
      res.end(JSON.stringify({ error: res.statusCode === 400 ? error.message : 'The browser could not access this source. Open verification, or check the website and VPS browser service.' }));
    }
  });
  server.requestTimeout = 65000;
  return { server, sessions, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await sessions.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createBrowserService();
  service.server.listen(Number(process.env.BROWSER_PORT) || 4190, process.env.BROWSER_HOST || '127.0.0.1', () => process.stdout.write('Source browser service is ready\n'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void service.close().then(() => process.exit(0)));
}
