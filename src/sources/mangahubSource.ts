// TypeScript port of Keiyoushi's MangaHub extension (Apache-2.0).
// See docs/SOURCES.md and THIRD_PARTY_NOTICES.md for the source reference.
import { blobPart } from '../lib/bytes';
import { backupSourceConfig } from './backupSources';
import type { Source, SChapter, SManga } from './Source';
import { validHubAccessKey } from './mangahubAccess';
import { currentChapterUrl, manga, pages, requireItems, retainChapterIds, sourceRequest, SourceRequestError, status } from './sourceUtils';

const config = backupSourceConfig('4758858684982406533');
const api = 'https://api.mghcdn.com/graphql';
interface HubManga { title: string; slug: string; image?: string; author?: string; artist?: string; description?: string; alternativeTitle?: string; genres?: string; status?: string; chapters?: { number: number; title: string; date: string }[] }
interface GraphQL<T> { data?: T; errors?: { message?: string }[]; message?: string }
class HubApiError extends Error {}
function sessionError(error: unknown): boolean {
  return error instanceof SourceRequestError ? [401, 403].includes(error.status) : error instanceof HubApiError && /rate\s*limit|api\s*key|encryption|permission to access|unauthori[sz]ed|access.*(?:denied|expired|invalid)/i.test(error.message);
}
export class MangaHubSession {
  private accessKey?: string;
  private refreshing?: Promise<void>;
  private key(): string {
    if (!this.accessKey) {
      try { const saved = sessionStorage.getItem('mihon-mangahub-access'); if (validHubAccessKey(saved)) this.accessKey = saved; } catch { /* storage unavailable */ }
      this.accessKey ??= this.randomKey();
    }
    return this.accessKey;
  }
  private randomKey(): string { return [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join(''); }
  private save(value: string | null): void {
    if (!validHubAccessKey(value)) return;
    this.accessKey = value;
    try { sessionStorage.setItem('mihon-mangahub-access', value); } catch { /* storage unavailable */ }
  }
  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await sourceRequest(config, url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'X-Mhub-Access': this.key() } });
    this.save(response.headers.get('X-Mhub-Access'));
    try { return await response.json() as T; }
    catch { throw new Error('MangaHub returned an invalid response. The website may have changed or blocked the request.'); }
  }
  private async refresh(oldKey: string, page: string): Promise<void> {
    if (this.key() !== oldKey) return;
    if (this.refreshing) return this.refreshing;
    const pending = (async () => {
      for (const reload of [true, false]) {
        const url = new URL(page, config.baseUrl);
        if (reload) url.searchParams.set('reloadKey', '1');
        try {
          const response = await sourceRequest(config, url.href, { refreshSession: true, headers: { 'X-Mhub-Access': this.key() } });
          this.save(response.headers.get('X-Mhub-Access'));
          await response.body?.cancel();
          if (this.key() !== oldKey) return;
        } catch { /* keep the API error if the website cannot refresh its key */ }
      }
    })();
    this.refreshing = pending;
    try { await pending; } finally { if (this.refreshing === pending) this.refreshing = undefined; }
  }
  async query<T>(value: string, signal?: AbortSignal, page = config.baseUrl + '/chapter/martial-peak/chapter-1000'): Promise<T> {
    const request = async () => {
      const result = await this.json<GraphQL<T>>(api, { method: 'POST', body: JSON.stringify({ query: value }), signal, headers: { 'Content-Type': 'application/json' } });
      if (result.errors?.length || !result.data) throw new HubApiError(`MangaHub: ${result.errors?.[0]?.message ?? result.message ?? 'No data returned by the source'}`);
      return result.data;
    };
    const oldKey = this.key();
    try { return await request(); }
    catch (error) {
      if (!sessionError(error)) throw error;
      await this.refresh(oldKey, page);
      signal?.throwIfAborted();
      if (this.key() !== oldKey) {
        try { return await request(); } catch (retryError) { if (!sessionError(retryError)) throw retryError; }
      }
      // The upstream extension makes one final attempt with a fresh key.
      this.save(this.randomKey());
      return request();
    }
  }
}
const session = new MangaHubSession();
function slug(id: string): string {
  const path = new URL(id, config.baseUrl).pathname;
  const value = /^\/(?:manga\/|chapter\/)?([^/]+)/.exec(path)?.[1];
  if (!value) throw new Error('Invalid MangaHub title URL');
  return value;
}
function mapManga(value: HubManga, id = '/manga/' + value.slug): SManga {
  const item = manga(config, id, value.title, value.image ? new URL(value.image, 'https://thumb.mghcdn.com/').href : '');
  return { ...item, author: value.author, artist: value.artist, description: [value.description, value.alternativeTitle ? 'Alternative names: ' + value.alternativeTitle : ''].filter(Boolean).join('\n\n'), genres: value.genres?.split(',').map(s => s.trim()).filter(Boolean) ?? [], status: status(value.status ?? '') };
}
async function listing(page: number, order: string, search = ''): Promise<SManga[]> {
  const result = await session.query<{ search: { rows: HubManga[] } }>(`{search(x:m01,q:${JSON.stringify(search)},genre:"all",mod:${order},hideNSFW:false,hideYaoi:false,offset:${(Math.max(1, page) - 1) * 30}){rows{title slug image}}}`);
  if (!Array.isArray(result.search?.rows)) throw new Error('MangaHub returned an invalid catalog');
  return result.search.rows.map(value => mapManga(value));
}
async function details(id: string): Promise<HubManga> {
  const result = await session.query<{ manga: HubManga | null }>(`{manga(x:m01,slug:${JSON.stringify(slug(id))}){title slug status image author artist genres description alternativeTitle chapters{number title date}}}`, undefined, config.baseUrl + '/manga/' + slug(id));
  if (!result.manga) throw new Error('This title is unavailable on MangaHub');
  return result.manga;
}
function decodeBase64(input: string): Uint8Array {
  return Uint8Array.from(atob(input.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}
export async function decryptHubPages(value: string, parameters: { keys?: Record<string, string>; key?: string; keyId?: string }): Promise<string> {
  const [prefix, version, id, iv, tag, data] = value.split(':');
  if (prefix !== 'enc' || version !== 'v1' || !id || !iv || !tag || !data) throw new Error('Unsupported MangaHub page format');
  const material = parameters.keys?.[id] ?? (!parameters.keyId || parameters.keyId === id ? parameters.key : undefined);
  if (!material) throw new Error('MangaHub did not provide the chapter decoding key');
  const cipher = decodeBase64(data), auth = decodeBase64(tag);
  const bytes = new Uint8Array(cipher.length + auth.length); bytes.set(cipher); bytes.set(auth, cipher.length);
  const cryptoKey = await crypto.subtle.importKey('raw', blobPart(decodeBase64(material)), 'AES-GCM', false, ['decrypt']);
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blobPart(decodeBase64(iv)), tagLength: 128 }, cryptoKey, blobPart(bytes))); }
  catch { throw new Error('MangaHub chapter decoding failed. Try refreshing the chapter.'); }
}
export function hubPagePaths(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  if (parsed && typeof parsed === 'object') {
    const object = parsed as Record<string, unknown>;
    if (Array.isArray(object.i) && typeof object.p === 'string') return object.i.filter((item): item is string => typeof item === 'string').map(item => object.p + item);
    return Object.values(object).filter((item): item is string => typeof item === 'string');
  }
  throw new Error('MangaHub returned an invalid page list');
}
export const mangahubSource: Source = {
  ...config, kind: 'builtin', lang: 'en', supportsLatest: true,
  getPopularManga: page => listing(page, 'POPULAR'),
  getLatestUpdates: page => listing(page, 'LATEST'),
  searchManga: (search, page) => listing(page, 'POPULAR', search),
  async getMangaDetails(id) { return mapManga(await details(id), id); },
  async getChapterList(id) {
    const value = await details(id);
    const chapters: SChapter[] = (value.chapters ?? []).map((chapter, index) => {
      // Kotlin Float.toString retains .0; old backup keys use this format.
      const number = Number.isInteger(chapter.number) ? chapter.number.toFixed(1) : String(chapter.number);
      const url = `/${value.slug}/chapter-${number}`;
      return { id: url, url, mangaId: id, number: chapter.number, name: chapter.title?.trim() ? chapter.title.includes(String(chapter.number)) ? chapter.title.trim() : `Chapter ${chapter.number} - ${chapter.title.trim()}` : `Chapter ${chapter.number}`, dateUpload: Date.parse(chapter.date) || 0, sourceOrder: index };
    });
    return retainChapterIds(config, id, requireItems(config, chapters, 'chapters'));
  },
  async getPageList(chapterId, mangaId, signal) {
    const url = await currentChapterUrl(config, chapterId, mangaId);
    const match = /^\/(?:chapter\/)?([^/]+)\/chapter-(\d+(?:\.\d+)?)/.exec(new URL(url, config.baseUrl).pathname);
    if (!match) throw new Error('Invalid MangaHub chapter URL');
    const result = await session.query<{ chapter: { pages: string } | null }>(`{chapter(x:m01,slug:${JSON.stringify(match[1])},number:${Number(match[2])}){pages mangaID number}}`, signal, `${config.baseUrl}/chapter/${match[1]}/chapter-${match[2]}`);
    if (!result.chapter?.pages) throw new Error('MangaHub did not return chapter pages');
    let value = result.chapter.pages;
    if (value.startsWith('enc:')) value = await decryptHubPages(value, await session.json(config.baseUrl + '/api/chapter-crypto', { signal }));
    return pages(config, hubPagePaths(value).map(path => new URL(path.replace(/^\//, ''), 'https://imgx.mghcdn.com/').href));
  },
};
