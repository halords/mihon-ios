// Ports of the YiiMadara, Madara, MangaBox and MangaFox source formats.
// Remote scripts are parsed as data only. See THIRD_PARTY_NOTICES.md.
import { backupSourceConfig, type BackupSourceConfig } from './backupSources';
import type { Source, SChapter, SManga } from './Source';
import { absolute, chapterDate, chapterNumber, currentChapterUrl, imageUrl, manga, pages, requireItems, retainChapterIds, sourceDocument, sourceJson, status, storedTitle, text } from './sourceUtils';

function info(document: Document, label: string): string {
  const row = [...document.querySelectorAll('.post-content_item, .minfo, .manga-info-text li, .variations-tableInfo tr, .manga-info-top li')].find(row => text(row).toLowerCase().startsWith(label.toLowerCase()));
  return text(row?.querySelector('.summary-content, i, td:last-child') ?? row).replace(new RegExp('^' + label + '\\s*:?\\s*', 'i'), '');
}
function parseCards(config: BackupSourceConfig, document: Document, selector: string, base: string, absoluteIds = false): SManga[] {
  const result = [...document.querySelectorAll(selector)].flatMap(element => {
    const link = element.querySelector<HTMLAnchorElement>('h3 a, h2 a, .item-title a, a[title], a');
    if (!link?.getAttribute('href')) return [];
    const url = new URL(link.getAttribute('href')!, base);
    const title = link.getAttribute('title') || text(link) || element.querySelector('img')?.getAttribute('alt') || '';
    if (!title) return [];
    const id = absoluteIds ? url.href : url.pathname;
    return [manga(config, id, title, imageUrl(element.querySelector('img'), base))];
  });
  return [...new Map(result.map(item => [item.id, item])).values()];
}
function parseChapters(config: BackupSourceConfig, document: Document, id: string, selector: string, base: string, absoluteIds = false): SChapter[] {
  const chapters = [...document.querySelectorAll(selector)].flatMap((element, index) => {
    const link = element.matches('a') ? element : element.querySelector('a');
    const href = link?.getAttribute('href');
    if (!href) return [];
    const full = new URL(href, base);
    const url = absoluteIds ? full.href : full.pathname + full.search;
    const name = text(link?.querySelector('.detail-main-list-main p')) || text(link);
    return [{ id: url, url, mangaId: id, name, number: chapterNumber(name), dateUpload: chapterDate(text(element.querySelector('.chapter-time, .chapter-release-date, .chapter-time, time')) || text(element.querySelector('.detail-main-list-main p:last-child'))), sourceOrder: index }];
  });
  return requireItems(config, [...new Map(chapters.map(chapter => [chapter.id, chapter])).values()], 'chapters');
}
function wordpressSource(sourceId: string, yii: boolean): Source {
  const config = backupSourceConfig(sourceId);
  async function list(page: number, mode: string, search = '') {
    const path = yii ? search ? `/search?${new URLSearchParams({ q: search.replaceAll("'", '’'), page: String(page) })}` : `/webtoons/${page}${mode === 'popular' ? '?orderby=trending' : ''}` : `/${page > 1 ? 'page/' + page + '/' : ''}?${new URLSearchParams({ s: search, post_type: 'wp-manga', m_orderby: mode === 'popular' ? 'views' : 'latest' })}`;
    const url = config.baseUrl + path;
    const items = parseCards(config, await sourceDocument(config, url), '.page-item-detail, .page-item, .home-item, .manga-item', url);
    return sourceId === '993336618407081332' ? items.filter(item => !/-raw\/?$/.test(item.id) && !/ raw$/i.test(item.title)) : items;
  }
  return {
    ...config, kind: 'builtin', lang: 'en', supportsLatest: true,
    getPopularManga: page => list(page, 'popular'), getLatestUpdates: page => list(page, 'latest'), searchManga: (search, page) => list(page, 'popular', search),
    async getMangaDetails(id) {
      const url = absolute(id, config.baseUrl), document = await sourceDocument(config, url);
      const title = text(document.querySelector('.post-title h1'));
      if (!title) throw new Error(`${config.name} no longer provides this title at its original URL. Use Migrate source from the title details.`);
      return { ...manga(config, id, title, imageUrl(document.querySelector('.summary_image img'), url)), author: info(document, 'Author'), artist: info(document, 'Artist'), genres: info(document, 'Genre').split(',').map(genre => genre.trim()).filter(Boolean), status: status(info(document, 'Status')), description: text(document.querySelector('.dsct, .ss-manga, .description-summary, .summary__content, .post-content_item .entry-content')) };
    },
    async getChapterList(id) {
      const url = absolute(id, config.baseUrl);
      let document = await sourceDocument(config, url);
      if (!yii && !document.querySelector('.wp-manga-chapter a')) document = await sourceDocument(config, url.replace(/\/$/, '') + '/ajax/chapters/', { method: 'POST' });
      return retainChapterIds(config, id, parseChapters(config, document, id, yii ? 'ul.row-content-chapter li' : '.wp-manga-chapter', url, true));
    },
    async getPageList(chapterId, mangaId, signal) {
      const url = new URL(await currentChapterUrl(config, chapterId, mangaId), config.baseUrl); url.searchParams.set('style', 'list');
      const document = await sourceDocument(config, url.href, { signal });
      return pages(config, [...document.querySelectorAll(yii ? '.read-content img' : '.reading-content img')].map(element => imageUrl(element, url.href)));
    },
  };
}
export const manhwa18Source = wordpressSource('993336618407081332', true);
export const manhwa18LegacySource = wordpressSource('4841602236575491202', true);
export const kissmangaSource = wordpressSource('3112384885023225761', false);

const box = backupSourceConfig('2528986671771677900');
async function boxSlug(id: string): Promise<string> {
  const part = new URL(id, box.baseUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (/^manga-[a-z]{2}\d+$/.test(part) || /^[a-z]{2}\d+$/.test(part)) {
    const title = await storedTitle(box, id);
    if (!title) throw new Error('Restore this Mangakakalot title before refreshing its old URL.');
    return title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
  }
  return part.replace(/^manga-/, '');
}
function scriptStringArray(document: Document, variable: string): string[] {
  const script = [...document.querySelectorAll('script')].map(element => element.textContent).join('\n');
  const value = new RegExp('\\b' + variable + '\\s*=\\s*(\\[[^\\]]*\\])').exec(script)?.[1];
  if (!value) return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; }
  catch { throw new Error('The source returned an unsupported image list'); }
}
export const mangakakalotSource: Source = {
  ...box, kind: 'builtin', lang: 'en', supportsLatest: true,
  async getPopularManga(page) { const url = `${box.baseUrl}/manga-list/hot-manga?page=${page}`; return parseCards(box, await sourceDocument(box, url), '.list-truyen-item-wrap, .list-comic-item-wrap, .story_item', url, true); },
  async getLatestUpdates(page) { const url = `${box.baseUrl}/manga-list/latest-manga?page=${page}`; return parseCards(box, await sourceDocument(box, url), '.list-truyen-item-wrap, .list-comic-item-wrap, .story_item', url, true); },
  async searchManga(search, page) { const url = `${box.baseUrl}/search/story/${encodeURIComponent(search.replaceAll(' ', '_'))}?page=${page}`; return parseCards(box, await sourceDocument(box, url), '.story_item, .list-truyen-item-wrap, .list-comic-item-wrap', url, true); },
  async getMangaDetails(id) {
    const url = `${box.baseUrl}/manga/${await boxSlug(id)}`, document = await sourceDocument(box, url);
    const title = text(document.querySelector('.manga-info-top h1, .panel-story-info h1, .panel-story-info h2'));
    if (!title) throw new Error('This Mangakakalot title could not be resolved. Use Migrate source from its details.');
    // The current extension derives old opaque URLs from the saved title.
    // Verify the exact normalized name before attaching a replacement URL.
    const previousTitle = await storedTitle(box, id);
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (previousTitle && normalize(previousTitle) !== normalize(title)) throw new Error('Mangakakalot returned a different title for this old URL. Use Migrate source to select its replacement.');
    return { ...manga(box, id, title, imageUrl(document.querySelector('.manga-info-pic img, .info-image img'), url)), author: info(document, 'Author'), genres: info(document, 'Genres').split(',').map(value => value.trim()).filter(Boolean), status: status(info(document, 'Status')), description: text(document.querySelector('#noidungm, #panel-story-info-description, #contentBox')) };
  },
  async getChapterList(id) {
    const value = await this.getMangaDetails(id);
    const slug = await boxSlug(id);
    const result = await sourceJson<{ success: boolean; data?: { chapters?: { chapter_slug?: string; chapter_name?: string; chapter_num?: number; updated_at?: string }[] } }>(box, `${box.baseUrl}/api/manga/${slug}/chapters?limit=-1`);
    if (!result.success || !Array.isArray(result.data?.chapters)) throw new Error('Mangakakalot could not load the chapter list for ' + value.title);
    const chapters = result.data.chapters.flatMap((chapter, index) => {
      if (!chapter.chapter_slug) return [];
      const url = `${box.baseUrl}/manga/${slug}/${chapter.chapter_slug}`;
      return [{ id: url, url, mangaId: id, name: chapter.chapter_name ?? `Chapter ${chapter.chapter_num}`, number: chapter.chapter_num ?? chapterNumber(chapter.chapter_name ?? ''), dateUpload: Date.parse(chapter.updated_at ?? '') || 0, sourceOrder: index }];
    });
    return retainChapterIds(box, id, requireItems(box, chapters, 'chapters'));
  },
  async getPageList(chapterId, mangaId, signal) {
    let url = await currentChapterUrl(box, chapterId, mangaId);
    // Old Manganato URLs need a refreshed list to supply the current URL.
    if (mangaId && /chapmanganato|manganato\./.test(url)) { await this.getChapterList(mangaId).then(async chapters => { url = chapters.find(chapter => chapter.id === chapterId)?.url ?? url; }); }
    const document = await sourceDocument(box, url, { signal });
    const paths = scriptStringArray(document, 'chapterImages');
    const cdns = scriptStringArray(document, 'cdns');
    return pages(box, paths.length && cdns.length ? paths.map(path => absolute(path, cdns[0].replace(/\/$/, '') + '/')) : [...document.querySelectorAll('.container-chapter-reader > img')].map(element => imageUrl(element, url)));
  },
};

const fox = backupSourceConfig('6484561431658238800');
export const mangafoxSource: Source = {
  ...fox, kind: 'builtin', lang: 'en', supportsLatest: true,
  async getPopularManga(page) { const url = `${fox.baseUrl}/directory/${page > 1 ? page + '.html' : ''}`; return parseCards(fox, await sourceDocument(fox, url), 'ul.manga-list-1-list li', url); },
  async getLatestUpdates(page) { const url = `${fox.baseUrl}/directory/${page > 1 ? page + '.html' : ''}?latest`; return parseCards(fox, await sourceDocument(fox, url), 'ul.manga-list-1-list li', url); },
  async searchManga(search, page) { const url = `${fox.baseUrl}/search?${new URLSearchParams({ title: search, page: String(page), stype: '1' })}`; return parseCards(fox, await sourceDocument(fox, url), 'ul.manga-list-4-list li', url); },
  async getMangaDetails(id) {
    const url = absolute(id, fox.baseUrl), document = await sourceDocument(fox, url);
    const title = text(document.querySelector('.detail-info-right-title-font'));
    if (!title) throw new Error('This title is unavailable on MangaFox');
    return { ...manga(fox, id, title, imageUrl(document.querySelector('.detail-info-cover-img'), url)), author: [...document.querySelectorAll('.detail-info-right-say a')].map(text).join(', '), genres: [...document.querySelectorAll('.detail-info-right-tag-list a')].map(text), status: status(text(document.querySelector('.detail-info-right-title-tip'))), description: text(document.querySelector('p.fullcontent')) };
  },
  async getChapterList(id) { const url = absolute(id, fox.baseUrl); return retainChapterIds(fox, id, parseChapters(fox, await sourceDocument(fox, url), id, 'ul.detail-main-list li a', url)); },
  async getPageList(chapterId, mangaId, signal) {
    const path = new URL(await currentChapterUrl(fox, chapterId, mangaId), fox.baseUrl).pathname.replace('/manga/', '/roll_manga/');
    const url = 'https://m.fanfox.net' + path;
    return pages(fox, [...(await sourceDocument(fox, url, { signal })).querySelectorAll('#viewer img')].map(element => imageUrl(element, url)));
  },
};
