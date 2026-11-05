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
