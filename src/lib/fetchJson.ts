import { loadSettings } from './settings';

export function proxiedUrl(url: string): string {
  const { proxyBase } = loadSettings();
  return proxyBase ? `${proxyBase.replace(/\/$/, '')}/${url}` : url;
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
