import { fetchWithTimeout } from '../lib/fetchJson';
import { browserSourceEnabled } from '../lib/browserSources';
import { getChapterMetas, getManga } from '../lib/db';
import { allowedSourceUrl, type BackupSourceConfig } from './backupSources';
import { mangaKey, type MangaPage, type MangaStatus, type SChapter, type SManga } from './Source';

export function sourceProxyUrl(config: BackupSourceConfig, input: string, image = false): string {
  const url = new URL(input, config.baseUrl);
  if (!allowedSourceUrl(config, url, image)) throw new Error(`${config.name} returned an unsupported ${image ? 'image' : 'website'} host: ${url.hostname}`);
  return `/api/source?${new URLSearchParams({ source: config.id, url: url.href, ...(image ? { image: '1' } : {}), ...(browserSourceEnabled(config.id) ? { browser: '1' } : {}) })}`;
}

export class SourceRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export interface SourceRequestInit extends RequestInit { refreshSession?: boolean }
export async function sourceRequest(config: BackupSourceConfig, url: string, init: SourceRequestInit = {}): Promise<Response> {
  const { refreshSession, ...request } = init;
  const response = await fetchWithTimeout(sourceProxyUrl(config, url) + (refreshSession ? '&refresh=1' : ''), request);
  if (!response.ok) {
    const body = await response.text();
    let message: string | undefined;
    try { message = (JSON.parse(body) as { error?: string }).error; } catch { /* upstream HTML */ }
    throw new SourceRequestError(message ?? (response.status === 403 ? `${config.name} is blocking app requests. Try again later or open the source website.` : `${config.name} request failed (HTTP ${response.status}).`), response.status);
  }
  return response;
}
export async function sourceJson<T>(config: BackupSourceConfig, url: string, init?: RequestInit): Promise<T> {
  const response = await sourceRequest(config, url, init);
  const text = await response.text();
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`${config.name} returned an invalid response. The website may have changed or blocked the request.`); }
}

const documents = new Map<string, { at: number; pending: Promise<Document> }>();
export function sourceDocument(config: BackupSourceConfig, url: string, init?: RequestInit): Promise<Document> {
  const key = config.id + ':' + (browserSourceEnabled(config.id) ? 'browser:' : 'http:') + url;
  const hit = documents.get(key);
  if (!init?.signal && !init?.method && hit && Date.now() - hit.at < 30000) return hit.pending;
  const pending = (async () => {
    const text = await (await sourceRequest(config, url, init)).text();
    if (/just a moment|cf-chl-|verify you are human/i.test(text)) throw new Error(`${config.name} is blocking app requests. Try again later or open the source website.`);
    // DOMParser keeps source scripts inert; never execute remote page scripts.
    return new DOMParser().parseFromString(text, 'text/html');
  })();
  if (!init?.signal && !init?.method) {
    if (documents.size > 40) documents.clear();
    documents.set(key, { at: Date.now(), pending });
    void pending.catch(() => documents.delete(key));
  }
  return pending;
}
export function text(element: Element | null | undefined): string { return element?.textContent?.trim().replace(/\s+/g, ' ') ?? ''; }
export function absolute(input: string, base: string): string { return input ? new URL(input, base).href : ''; }
export function imageUrl(element: Element | null, base: string): string {
  return absolute(element?.getAttribute('data-src') || element?.getAttribute('data-original') || element?.getAttribute('src') || '', base);
}
export function status(value: string): MangaStatus {
  const lower = value.toLowerCase();
  return /complete|finished/.test(lower) ? 'Completed' : /ongoing/.test(lower) ? 'Ongoing' : /hiatus|hold/.test(lower) ? 'On Hold' : /cancel|dropped/.test(lower) ? 'Cancelled' : 'Unknown';
}
export function chapterNumber(name: string): number {
  const value = /(?:chapter|ch\.?|c)\s*[-: ]?\s*(\d+(?:\.\d+)?)/i.exec(name)?.[1];
  return value ? Number(value) : -1;
}
export function chapterDate(value: string): number {
  const ago = /(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i.exec(value);
  if (ago) return Date.now() - Number(ago[1]) * ({ minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 }[ago[2].toLowerCase()] ?? 0);
  if (/today/i.test(value)) return Date.now();
  if (/yesterday/i.test(value)) return Date.now() - 86400000;
  return Date.parse(value) || 0;
}
export function manga(config: BackupSourceConfig, id: string, title: string, coverUrl = ''): SManga {
  return { id, sourceId: config.id, sourceName: config.name, url: id, title, coverUrl, description: '', genres: [], status: 'Unknown' };
}
export function requireItems<T>(config: BackupSourceConfig, items: T[], what: string): T[] {
  if (!items.length) throw new Error(`${config.name} did not return ${what}. The title may be unavailable or the website may have changed.`);
  return items;
}
export function pages(config: BackupSourceConfig, urls: string[]): MangaPage[] {
  return requireItems(config, [...new Set(urls.filter(Boolean))].map(url => ({ imageUrl: sourceProxyUrl(config, url, true) })), 'readable pages');
}

function normalizedUrl(input: string): string {
  const url = new URL(input, 'https://source.invalid');
  url.searchParams.delete('style');
  return url.pathname.replace(/\/$/, '').replace(/(chapter-\d+)\.0$/, '$1') + url.search;
}
/** Reuse old chapter keys only for unambiguous matches within this exact title.
 * The refreshed URL remains available for requests and Android export. */
export async function retainChapterIds(config: BackupSourceConfig, mangaId: string, incoming: SChapter[]): Promise<SChapter[]> {
  const old = (await getChapterMetas(mangaKey(config.id, mangaId))).map(record => record.chapter);
  const byId = new Map(old.map(chapter => [chapter.id, chapter]));
  const byUrl = new Map<string, SChapter[]>();
  for (const chapter of old) {
    const url = normalizedUrl(chapter.url ?? chapter.id), matches = byUrl.get(url) ?? [];
    matches.push(chapter); byUrl.set(url, matches);
  }
  const counts = (list: SChapter[]) => {
    const map = new Map<number, SChapter[]>();
    for (const chapter of list) { const group = map.get(chapter.number) ?? []; group.push(chapter); map.set(chapter.number, group); }
    return map;
  };
  const oldNumbers = counts(old), newNumbers = counts(incoming);
  const used = new Set<string>();
  return incoming.map(chapter => {
    const urlMatches = byUrl.get(normalizedUrl(chapter.url ?? chapter.id));
    let match = byId.get(chapter.id) ?? (urlMatches?.length === 1 ? urlMatches[0] : undefined);
    if (!match && chapter.number >= 0 && oldNumbers.get(chapter.number)?.length === 1 && newNumbers.get(chapter.number)?.length === 1) match = oldNumbers.get(chapter.number)![0];
    if (!match || used.has(match.id)) return chapter;
    used.add(match.id);
    return { ...chapter, id: match.id, scanlator: match.scanlator ?? chapter.scanlator, memo: match.memo ?? chapter.memo };
  });
}
export async function currentChapterUrl(config: BackupSourceConfig, chapterId: string, mangaId?: string): Promise<string> {
  if (!mangaId) return chapterId;
  const chapter = (await getChapterMetas(mangaKey(config.id, mangaId))).find(record => record.chapter.id === chapterId)?.chapter;
  return chapter?.url ?? chapterId;
}
export async function storedTitle(config: BackupSourceConfig, id: string): Promise<string | undefined> {
  return (await getManga(mangaKey(config.id, id)))?.manga.title;
}
