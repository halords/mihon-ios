// Port of Keiyoushi's Asura Scans API and Astro data format (Apache-2.0).
import { backupSourceConfig } from './backupSources';
import type { Source, SManga, SChapter } from './Source';
import { absolute, currentChapterUrl, manga, pages, requireItems, retainChapterIds, sourceDocument, sourceJson, status } from './sourceUtils';

const config = backupSourceConfig('6247824327199706550');
const api = 'https://api.asurascans.com/api';
const publicUrls = new Map<string, string>();
interface AsuraManga { slug: string; title: string; cover?: string; coverUrl?: string; public_url?: string; publicUrl?: string; description?: string; author?: string; artist?: string; genres?: { name: string }[]; status?: string }
interface Chapter { number: number; title?: string; created_at?: string; is_premium?: boolean; is_locked?: boolean; early_access_until?: string; series_slug?: string }
interface AsuraPage { url: string; tiles?: number[]; tile_cols?: number; tile_rows?: number }
function slug(id: string): string { return new URL(id, config.baseUrl).pathname.split('/').filter(Boolean)[1]?.replace(/-[a-z0-9]{8}$/, '') ?? ''; }
function mapManga(value: AsuraManga, id = '/series/' + value.slug): SManga {
  const url = value.public_url ?? value.publicUrl;
  if (url) publicUrls.set(slug(id), absolute(url, config.baseUrl));
  return { ...manga(config, id, value.title, value.cover ?? value.coverUrl), author: value.author, artist: value.artist, genres: value.genres?.map(genre => genre.name) ?? [], status: status(value.status ?? ''), description: value.description ? new DOMParser().parseFromString(value.description, 'text/html').body.textContent?.trim() ?? '' : '' };
}
async function listing(page: number, order: string, search = ''): Promise<SManga[]> {
  const params = new URLSearchParams({ offset: String((Math.max(1, page) - 1) * 20), limit: '20', sort: order });
  if (search) params.set('search', search);
  const result = await sourceJson<{ data: AsuraManga[] }>(config, `${api}/series?${params}`);
  if (!Array.isArray(result.data)) throw new Error('Asura Scans returned an invalid catalog');
  return result.data.map(value => mapManga(value));
}
/** Astro serializes values as [type, value] tuples, including nested arrays. */
export function unwrapAstro(value: unknown): unknown {
  if (Array.isArray(value)) {
    if ((value.length === 1 || value.length === 2) && typeof value[0] === 'number') return value.length === 1 ? null : unwrapAstro(value[1]);
    return value.map(unwrapAstro);
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapAstro(item)]));
  return value;
}
function astro<T>(document: Document, field: string): T {
  for (const element of document.querySelectorAll('[props]')) {
    const raw = element.getAttribute('props')!;
    if (!raw.includes(field)) continue;
    try {
      const data = unwrapAstro(JSON.parse(raw)) as Record<string, unknown>;
      if (data && field in data) return data as T;
    } catch { /* other island */ }
  }
  throw new Error(`Asura Scans did not provide ${field}. The website may have changed.`);
}
async function documentFor(id: string): Promise<Document> {
  const key = slug(id);
  if (!publicUrls.has(key)) {
    const results = await listing(1, 'popular', key.replaceAll('-', ' '));
    const exact = results.find(item => slug(item.id) === key);
    if (!exact) {
      // Stable /comics/<slug> paths redirect to the current suffix on the site.
      publicUrls.set(key, config.baseUrl + '/comics/' + key);
    }
  }
  return sourceDocument(config, publicUrls.get(key)!);
}
export const asuraSource: Source = {
  ...config, kind: 'builtin', lang: 'en', supportsLatest: true,
  getPopularManga: page => listing(page, 'popular'), getLatestUpdates: page => listing(page, 'latest'), searchManga: (search, page) => listing(page, 'popular', search),
  async getMangaDetails(id) {
    const document = await documentFor(id);
    const data = astro<AsuraManga>(document, 'description');
    const identity = astro<{ publicUrl: string; seriesSlug: string }>(document, 'publicUrl');
    if (identity.seriesSlug !== slug(id)) throw new Error('Asura Scans returned a different title. Use Migrate source to select the replacement.');
    publicUrls.set(slug(id), absolute(identity.publicUrl, config.baseUrl));
    return mapManga({ ...data, slug: identity.seriesSlug }, id);
  },
  async getChapterList(id) {
    const document = await documentFor(id);
    const data = astro<{ chapters: Chapter[] }>(document, 'chapters');
    const identity = astro<{ publicUrl: string; seriesSlug: string }>(document, 'publicUrl');
    if (identity.seriesSlug !== slug(id)) throw new Error('Asura Scans returned a different title. Use Migrate source to select the replacement.');
    publicUrls.set(slug(id), absolute(identity.publicUrl, config.baseUrl));
    const chapters: SChapter[] = (data.chapters ?? []).map((chapter, index) => {
      const url = `/series/${identity.seriesSlug}/chapter/${chapter.number}`;
      const locked = chapter.is_premium || chapter.is_locked || Date.parse(chapter.early_access_until ?? '') > Date.now();
      return { id: url, url, mangaId: id, name: `Chapter ${chapter.number}${chapter.title ? ' - ' + chapter.title : ''}${locked ? ' (subscription required)' : ''}`, number: chapter.number, dateUpload: Date.parse(chapter.created_at ?? '') || 0, sourceOrder: index, ...(locked ? { external: true, externalUrl: absolute(identity.publicUrl, config.baseUrl) + '/chapter/' + chapter.number } : {}) };
    });
    return retainChapterIds(config, id, requireItems(config, chapters, 'chapters'));
  },
  async getPageList(chapterId, mangaId, signal) {
    const chapterUrl = await currentChapterUrl(config, chapterId, mangaId);
    const match = /\/series\/([^/]+)\/chapter\/(\d+(?:\.\d+)?)/.exec(new URL(chapterUrl, config.baseUrl).pathname);
    if (!match) throw new Error('Invalid Asura Scans chapter URL');
    if (!publicUrls.has(match[1])) await documentFor('/series/' + match[1]);
    const url = publicUrls.get(match[1])! + '/chapter/' + match[2];
    const document = await sourceDocument(config, url, { signal });
    const result = astro<{ pages: AsuraPage[] }>(document, 'pages');
    const readable = requireItems(config, result.pages ?? [], 'public chapter pages');
    return readable.map(page => {
      const image = pages(config, [page.url])[0];
      if (page.tiles?.length) image.imageUrl += '#tiles=' + encodeURIComponent(JSON.stringify({ tiles: page.tiles, cols: page.tile_cols ?? 4, rows: page.tile_rows ?? 5 }));
      return image;
    });
  },
};
