import { useEffect, useState, type CSSProperties } from 'react';
import { cdnUrl, fetchImage } from '../lib/fetchJson';
import { coverArt } from '../sources/svgArt';

export const COVERS_CACHE = 'mihon-covers-v1';
const inflight = new Map<string, Promise<Blob | null>>();
export async function cacheCover(url: string): Promise<Blob | null> {
  if (!url || url.startsWith('data:') || url.startsWith('blob:') || typeof caches === 'undefined') return null;
  const existing = inflight.get(url);
  if (existing) return existing;
  const promise = (async () => {
    const cache = await caches.open(COVERS_CACHE);
    const key = `https://cache.mihon.local/cover/${encodeURIComponent(url)}`;
    const hit = await cache.match(key);
    if (hit) return hit.blob();
    if (navigator.onLine === false) return null;
    const blob = await fetchImage(url);
    await cache.put(key, new Response(blob, { headers: { 'Content-Type': blob.type } }));
    return blob;
  })().catch(() => null);
  inflight.set(url, promise);
  try { return await promise; } finally { inflight.delete(url); }
}
export default function Cover({ url, title, className = 'cover', style, alt = '' }: { url: string; title: string; className?: string; style?: CSSProperties; alt?: string }) {
  const fallback = coverArt(title, '', [...title].reduce((n, c) => n + c.charCodeAt(0), 0) % 360);
  const [src, setSrc] = useState(url.startsWith('data:') ? url : fallback);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setSrc(url.startsWith('data:') ? url : fallback);
    void cacheCover(url).then(blob => {
      if (!active) return;
      if (blob) { objectUrl = URL.createObjectURL(blob); setSrc(objectUrl); }
      else if (navigator.onLine !== false && url) setSrc(cdnUrl(url));
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, title]);
  return <img src={src} alt={alt} className={className} style={style} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setSrc(fallback)} />;
}
