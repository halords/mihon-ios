// Same-origin CORS proxy for the MangaDex API.
//
// Why this exists: api.mangadex.org only sends Access-Control-Allow-Origin
// for an allowlist of origins, and the deployed PWA origin is not on it, so
// direct browser calls fail. The PWA routes its MangaDex API calls through
// this function instead (see proxiedUrl in src/lib/fetchJson.ts). Image
// hosts (uploads.mangadex.org, *.mangadex.network) DO grant CORS to the PWA
// origin, so pages and covers are still fetched directly.
//
// GET only, MangaDex hosts only — this is not an open proxy.

const ALLOWED_SUFFIXES = ['.mangadex.org', '.mangadex.network'];
const ALLOWED_HOSTS = new Set(['mangadex.org', 'mangadex.network']);

function isAllowed(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname;
  return (
    ALLOWED_HOSTS.has(host) ||
    ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const target = req.query?.url;
  if (typeof target !== 'string' || !target) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    res.status(400).json({ error: 'Invalid url parameter' });
    return;
  }

  if (!isAllowed(url)) {
    res.status(403).json({ error: 'Host not allowed' });
    return;
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });
    const body = await upstream.arrayBuffer();
    res.status(upstream.status);
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') ?? 'application/json',
    );
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(Buffer.from(body));
  } catch {
    res.status(502).json({ error: 'Upstream request failed' });
  }
}
