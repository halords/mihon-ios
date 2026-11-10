import { backupSourceConfig } from './backupSources';
import type { Source, SChapter } from './Source';
import { currentChapterUrl, manga, pages, requireItems, retainChapterIds, sourceDocument } from './sourceUtils';

const config = backupSourceConfig('7798162483793432927');
/** Read JSON literals in the original reader without evaluating page scripts. */
export function readerLiteral<T>(document: Document, variable: string): T {
  const scripts = [...document.querySelectorAll('script')].map(script => script.textContent ?? '').join('\n');
  const start = new RegExp('\\bvm\\.' + variable + '\\s*=\\s*').exec(scripts);
  if (!start) throw new Error('MangaLife no longer provides its original reader data. Open the source website or migrate this title.');
  const offset = start.index + start[0].length;
  let inString = false, escaped = false, depth = 0;
  for (let i = offset; i < scripts.length; i++) {
    const char = scripts[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"') inString = !inString;
    if (!inString) {
      if (char === '[' || char === '{') depth++;
      if (char === ']' || char === '}') depth--;
      if (char === ';' && depth === 0) {
        try { return JSON.parse(scripts.slice(offset, i)) as T; }
        catch { break; }
      }
    }
  }
  throw new Error('MangaLife returned an unsupported reader format');
}
interface LifeManga { i: string; s: string; a?: string[]; g?: string[]; ss?: string; p?: string }
interface LifeChapter { Chapter: string; ChapterName?: string; Date?: string; Page?: string }
function chapterNumber(value: string): string {
  if (!/^\d{6,}$/.test(value)) throw new Error('Invalid MangaLife chapter number');
  return String(Number(value.slice(1, -1))) + (value.endsWith('0') ? '' : '.' + value.at(-1));
}
async function listing(): Promise<LifeManga[]> { return readerLiteral(await sourceDocument(config, config.baseUrl + '/directory/'), 'Directory'); }
export const mangalifeSource: Source = {
  ...config, kind: 'builtin', lang: 'en', supportsLatest: true,
  async getPopularManga(page) { return (await listing()).slice((page - 1) * 24, page * 24).map(item => manga(config, '/manga/' + item.i, item.s, item.p ?? `${config.baseUrl}/cover/${item.i}.jpg`)); },
  async getLatestUpdates(page) { const document = await sourceDocument(config, config.baseUrl + '/'); const items = readerLiteral<LifeManga[]>(document, 'LatestUpdates'); return items.slice((page - 1) * 24, page * 24).map(item => manga(config, '/manga/' + item.i, item.s, `${config.baseUrl}/cover/${item.i}.jpg`)); },
  async searchManga(search, page) { return (await listing()).filter(item => item.s.toLowerCase().includes(search.toLowerCase())).slice((page - 1) * 24, page * 24).map(item => manga(config, '/manga/' + item.i, item.s, `${config.baseUrl}/cover/${item.i}.jpg`)); },
  async getMangaDetails(id) {
    const key = new URL(id, config.baseUrl).pathname.split('/').at(-1);
    const item = (await listing()).find(item => item.i === key);
    if (!item) throw new Error('This original title is unavailable on MangaLife. Use Migrate source from its details.');
    return { ...manga(config, id, item.s, item.p ?? `${config.baseUrl}/cover/${item.i}.jpg`), author: item.a?.join(', '), genres: item.g ?? [], status: /complete/i.test(item.ss ?? '') ? 'Completed' as const : 'Unknown' as const };
  },
  async getChapterList(id) {
    const document = await sourceDocument(config, new URL(id, config.baseUrl).href);
    const values = readerLiteral<LifeChapter[]>(document, 'Chapters');
    const name = new URL(id, config.baseUrl).pathname.split('/').at(-1);
    const chapters: SChapter[] = values.map((chapter, index) => {
      const number = chapterNumber(chapter.Chapter);
      const suffix = chapter.Chapter[0] === '1' ? '' : '-index-' + chapter.Chapter[0];
      const url = `/read-online/${name}-chapter-${number}${suffix}.html`;
      return { id: url, url, mangaId: id, name: `Chapter ${number}${chapter.ChapterName ? ' - ' + chapter.ChapterName : ''}`, number: Number(number), dateUpload: Date.parse(chapter.Date ?? '') || 0, sourceOrder: index };
    });
    return retainChapterIds(config, id, requireItems(config, chapters, 'chapters'));
  },
  async getPageList(chapterId, mangaId, signal) {
    const url = new URL(await currentChapterUrl(config, chapterId, mangaId), config.baseUrl).href;
    const document = await sourceDocument(config, url, { signal });
    const value = readerLiteral<LifeChapter>(document, 'CurChapter');
    const host = readerLiteral<string>(document, 'CurPathName');
    const name = readerLiteral<string>(document, 'IndexName');
    const count = Number(value.Page);
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('MangaLife returned an invalid page count');
    const number = chapterNumber(value.Chapter).split('.').map((part, index) => index === 0 ? part.padStart(4, '0') : part).join('.');
    return pages(config, Array.from({ length: count }, (_, index) => `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}/manga/${name}/${number}-${String(index + 1).padStart(3, '0')}.png`));
  },
};
