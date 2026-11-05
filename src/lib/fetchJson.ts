import { loadSettings } from './settings';

export function proxiedUrl(url: string): string {
  const { proxyBase } = loadSettings();
  if (proxyBase) {
    return `${proxyBase.replace(/\/$/, '')}/${url}`;
  }
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
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  if (
    host !== 'uploads.mangadex.org' &&
    host !== 'mangadex.network' &&
    !host.endsWith('.mangadex.network')
  ) {
    return url;
  }
  if (proxyBase) {
    return `${proxyBase.replace(/\/$/, '')}/${url}`;
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

  const res = await fetch(proxiedUrl(url), { ...init, headers });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data: unknown = await res.json();
  return data as T;
}
