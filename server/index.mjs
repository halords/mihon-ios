import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { handleMangaDexProxy, handleSuwayomiProxy, proxyError } from './proxy.ts';
import { handleSourceProxy } from './sourceProxy.ts';

const root = resolve('dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/proxy?')) return await handleMangaDexProxy(req, res);
    if (req.url?.startsWith('/api/source?')) return await handleSourceProxy(req, res);
    if (req.url?.startsWith('/api/suwayomi/')) return await handleSuwayomiProxy(req, res);
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { proxyError(res, 405, 'Method not allowed'); return; }
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    let file = resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(root + sep)) { proxyError(res, 403, 'Invalid path'); return; }
    try { if (!(await stat(file)).isFile()) file = resolve(root, 'index.html'); }
    catch { if (extname(path)) { proxyError(res, 404, 'Not found'); return; } file = resolve(root, 'index.html'); }
    const body = await readFile(file);
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (path === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { proxyError(res, 500, 'Unable to serve this request'); }
});
server.listen(port, host, () => process.stdout.write(`Mihon PWA is running at http://localhost:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
