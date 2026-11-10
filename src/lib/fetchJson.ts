import { loadSettings } from './settings';
import { validateImageBlob } from './images';
import { backupSourceConfigs, allowedSourceUrl } from '../sources/backupSources';
import { decodeSourceImage } from './sourceImages';

function isBackendUrl(url: string): boolean {
  const base = loadSettings().suwayomiUrl;
  if (!base) return false;
  try {
    const origin = typeof location === 'undefined' ? 'https://mihon.local' : location.origin;
    const server = new URL(base, origin);
    const target = new URL(url, origin);
    return target.origin === server.origin && target.pathname.startsWith(`${server.pathname.replace(/\/$/, '')}/`);
  } catch { return false; }
}

function customProxy(url: string, base: string): string {
  const prefix = base.split('{url}')[0]!;
  if (prefix && url.startsWith(prefix)) return url;
  if (base.includes('{url}')) return base.replace('{url}', encodeURIComponent(url));
  const parsed = new URL(base);
  if (parsed.searchParams.has('url')) { parsed.searchParams.set('url', url); return parsed.href; }
  return `${base.replace(/\/$/, '')}/${url}`;
}

export function proxiedUrl(url: string): string {
  const { proxyBase } = loadSettings();
  if (proxyBase && /^https?:\/\//i.test(url) && !isBackendUrl(url)) return customProxy(url, proxyBase);
  // api.mangadex.org only grants CORS to an allowlist of origins and the
  // deployed PWA origin is not on it (verified 2026-11-05), so route MangaDex
  // API calls through the same-origin proxy function. Image hosts grant CORS
  // to this origin and are fetched directly.
  try {
    if (new URL(url).hostname === 'api.mangadex.org') {
      return `/api/proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {
    // Not an absolute URL; return as-is.
  }
  return url;
}

/**
 * Route a MangaDex image URL (covers on uploads.mangadex.org, chapter pages
 * on *.mangadex.network) through the proxy so the browser only ever loads
 * same-origin images. Direct loads from those hosts intermittently fail in
 * iOS WebKit (CDN referer redirects / service-worker handling). Non-MangaDex
 * URLs (data URIs, blob URLs, other hosts) pass through unchanged.
 */
export function cdnUrl(url: string): string {
  const { proxyBase } = loadSettings();
  if (proxyBase && /^https?:\/\//i.test(url) && !isBackendUrl(url)) return customProxy(url, proxyBase);
  let host: string;
  let parsed: URL;
  try {
    parsed = new URL(url);
    host = parsed.hostname;
  } catch {
    return url;
  }
  const builtin = backupSourceConfigs.find(source => allowedSourceUrl(source, parsed, true));
  if (builtin) return `/api/source?${new URLSearchParams({ source: builtin.id, url: parsed.href, image: '1' })}`;
  if (
    host !== 'uploads.mangadex.org' &&
    host !== 'mangadex.network' &&
    !host.endsWith('.mangadex.network')
  ) {
    return url;
  }
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });

  new Headers(init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });

  const res = await fetchWithTimeout(proxiedUrl(url), { ...init, headers });

  if (!res.ok) {
    void res.body?.cancel();
    throw new Error(res.status === 429 ? 'Source rate limit reached. Try again shortly.' : `Source request failed (HTTP ${res.status})`);
  }
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new Error('The source returned an invalid response. Check your connection or proxy settings.'); }
  return data as T;
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeout = 30000): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout);
  const cleanup = () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); };
  const requestError = (error: unknown): unknown => {
    if (init.signal?.aborted) return init.signal.reason ?? new DOMException('Cancelled', 'AbortError');
    if (controller.signal.aborted) return new DOMException('The source took too long to respond. Try again.', 'TimeoutError');
    if (error instanceof TypeError) return new Error('Unable to reach this source. Check your connection and proxy settings.');
    return error;
  };
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.body) { cleanup(); return response; }
    const reader = response.body.getReader();
    let finished = false;
    let onAbort: () => void;
    const finish = () => {
      finished = true;
      cleanup();
      controller.signal.removeEventListener('abort', onAbort);
    };
    const cancelReader = async (reason?: unknown) => {
      try { await reader.cancel(reason); } catch { /* connection already closed */ }
      finally { reader.releaseLock(); }
    };
    // Headers can arrive long before an image is complete. Keep the timer
    // and linked cancellation alive until the body is consumed or cancelled.
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        onAbort = () => {
          if (finished) return;
          const error = requestError(controller.signal.reason);
          finish();
          stream.error(error);
          void cancelReader(error);
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      },
      async pull(stream) {
        try {
          const { value, done } = await reader.read();
          if (finished) return;
          if (done) { finish(); reader.releaseLock(); stream.close(); }
          else stream.enqueue(value);
        } catch (error) {
          if (finished) return;
          finish();
          stream.error(requestError(error));
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        if (finished) return;
        finish();
        await cancelReader(reason);
        controller.abort(reason);
      },
    });
    const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    // Preserve useful fetch metadata when wrapping the native response.
    Object.defineProperties(result, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    });
    return result;
  } catch (error) {
    cleanup();
    throw requestError(error);
  }
}

export async function fetchImage(url: string, signal?: AbortSignal): Promise<Blob> {
  const target = url.startsWith('data:') || url.startsWith('blob:') ? url : cdnUrl(url);
  const headers = new Headers();
  if (isBackendUrl(target)) {
    try { const auth = sessionStorage.getItem('mihon:backend-auth'); if (auth) headers.set('Authorization', auth); } catch { /* no auth */ }
  }
  const response = await fetchWithTimeout(target, { signal, headers, credentials: 'same-origin', referrerPolicy: 'no-referrer' }, 60000);
  if (!response.ok) { void response.body?.cancel(); throw new Error(`Image download failed (HTTP ${response.status})`); }
  return decodeSourceImage(await validateImageBlob(await response.blob()), url, signal);
}
