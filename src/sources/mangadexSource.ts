import { cdnUrl, fetchJson } from '../lib/fetchJson';
import type {
  MangaPage,
  MangaStatus,
  SChapter,
  SManga,
  Source,
} from './Source';
import { coverArt } from './svgArt';

const BASE = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';
const SOURCE_ID = 'mangadex';
const LIST_LIMIT = 24;
const RATINGS: string[] = ['safe', 'suggestive'];

type LocalizedString = Record<string, string>;

interface MdTag {
  attributes?: {
    name?: LocalizedString;
  };
}

interface MdRelationship {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    fileName?: string;
  };
}

interface MdMangaAttributes {
  title?: LocalizedString;
  altTitles?: LocalizedString[];
  description?: LocalizedString;
  status?: string;
  tags?: MdTag[];
}

interface MdManga {
  id: string;
  attributes?: MdMangaAttributes;
  relationships?: MdRelationship[];
}

interface MdListResponse {
  data?: MdManga[];
  total?: number;
  limit?: number;
  offset?: number;
}

interface MdSingleResponse {
  data?: MdManga;
}

interface MdChapterAttributes {
  volume?: string | null;
  chapter?: string | null;
  title?: string | null;
  publishAt?: string;
  externalUrl?: string | null;
  pages?: number;
}

interface MdChapter {
  id: string;
  attributes?: MdChapterAttributes;
}

interface MdFeedResponse {
  data?: MdChapter[];
  total?: number;
  limit?: number;
  offset?: number;
}

interface MdAtHome {
  baseUrl?: string;
  chapter?: {
    hash?: string;
    data?: string[];
  };
}

function buildUrl(path: string, params: Array<[string, string]>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of params) {
    usp.append(key, value);
  }
  return `${BASE}${path}?${usp.toString()}`;
}

function mangaParams(
  extra: Array<[string, string]>,
): Array<[string, string]> {
  return [
    ...extra,
    ['includes[]', 'cover_art'],
    ['includes[]', 'author'],
    ['includes[]', 'artist'],
    ...RATINGS.map((r): [string, string] => ['contentRating[]', r]),
  ];
}

const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 60_000;

async function cachedJson<T>(url: string): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) {
    return hit.value as T;
  }

  const value = await fetchJson<T>(url);
  cache.set(url, { at: Date.now(), value });
  return value;
}

function pickLocalized(
  map: LocalizedString | undefined,
): string | undefined {
  if (!map) {
    return undefined;
  }
  return map.en ?? Object.values(map)[0];
}

function mapManga(m: MdManga): SManga {
  const attrs = m.attributes ?? {};
  let title = pickLocalized(attrs.title);

  if (!title && attrs.altTitles) {
    for (const alt of attrs.altTitles) {
      title = pickLocalized(alt);
      if (title) {
        break;
      }
    }
  }

  title = title ?? 'Untitled';

  const author = m.relationships?.find(
    (r) => r.type === 'author',
  )?.attributes?.name;
  const artist = m.relationships?.find(
    (r) => r.type === 'artist',
  )?.attributes?.name;
  const coverRel = m.relationships?.find((r) => r.type === 'cover_art');
  const fileName = coverRel?.attributes?.fileName;
  const hue =
    [...m.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  const coverUrl = fileName
    ? `${UPLOADS}/covers/${m.id}/${fileName}.256.jpg`
    : coverArt(title, author, hue);

  const status: MangaStatus =
    attrs.status === 'ongoing'
      ? 'Ongoing'
      : attrs.status === 'completed'
        ? 'Completed'
        : attrs.status === 'hiatus'
          ? 'On Hold'
          : 'Unknown';

  const genres = (attrs.tags ?? [])
    .map((t) => pickLocalized(t.attributes?.name))
    .filter((g): g is string => !!g);

  return {
    id: m.id,
    sourceId: SOURCE_ID,
    title,
    author,
    artist,
    status,
    description: pickLocalized(attrs.description) ?? '',
    genres,
    coverUrl,
  };
}

export const mangadexSource: Source = {
  id: SOURCE_ID,
  name: 'MangaDex',

  async getPopularManga(page: number): Promise<SManga[]> {
    const offset = (Math.max(1, page) - 1) * LIST_LIMIT;
    const url = buildUrl(
      '/manga',
      mangaParams([
        ['limit', String(LIST_LIMIT)],
        ['offset', String(offset)],
        ['order[followedCount]', 'desc'],
      ]),
    );

    const res = await cachedJson<MdListResponse>(url);
    return (res.data ?? []).map(mapManga);
  },

  async getLatestUpdates(page: number): Promise<SManga[]> {
    const offset = (Math.max(1, page) - 1) * LIST_LIMIT;
    const url = buildUrl(
      '/manga',
      mangaParams([
        ['limit', String(LIST_LIMIT)],
        ['offset', String(offset)],
        ['order[latestUploadedChapter]', 'desc'],
      ]),
    );

    const res = await cachedJson<MdListResponse>(url);
    return (res.data ?? []).map(mapManga);
  },

  async searchManga(query: string, page: number): Promise<SManga[]> {
    const offset = (Math.max(1, page) - 1) * LIST_LIMIT;
    const url = buildUrl(
      '/manga',
      mangaParams([
        ['limit', String(LIST_LIMIT)],
        ['offset', String(offset)],
        ['title', query],
        ['order[relevance]', 'desc'],
      ]),
    );

    const res = await cachedJson<MdListResponse>(url);
    return (res.data ?? []).map(mapManga);
  },

  async getMangaDetails(id: string): Promise<SManga> {
    const url = buildUrl(`/manga/${id}`, mangaParams([]));
    const res = await cachedJson<MdSingleResponse>(url);

    if (!res.data) {
      throw new Error('Manga not found on MangaDex');
    }

    return mapManga(res.data);
  },

  async getChapterList(mangaId: string): Promise<SChapter[]> {
    function mapChapter(c: MdChapter): SChapter {
      const numStr = c.attributes?.chapter ?? null;
      const number = numStr !== null ? Number.parseFloat(numStr) : 0;
      const safeNumber = Number.isFinite(number) ? number : 0;
      const t = c.attributes?.title ?? null;
      const name =
        numStr !== null
          ? t
            ? `Chapter ${numStr} - ${t}`
            : `Chapter ${numStr}`
          : (t ?? 'Oneshot');
      const dateUpload = Date.parse(c.attributes?.publishAt ?? '') || 0;
      const external =
        !!(c.attributes?.externalUrl ?? null) || c.attributes?.pages === 0;

      return {
        id: c.id,
        mangaId,
        name,
        number: safeNumber,
        dateUpload,
        ...(external ? { external: true } : {}),
      };
    }

    const all: SChapter[] = [];
    let offset = 0;
    const FEED_LIMIT = 500;

    while (true) {
      const url = buildUrl(`/manga/${mangaId}/feed`, [
        ['translatedLanguage[]', 'en'],
        ...RATINGS.map((r): [string, string] => ['contentRating[]', r]),
        ['order[volume]', 'asc'],
        ['order[chapter]', 'asc'],
        ['limit', String(FEED_LIMIT)],
        ['offset', String(offset)],
      ]);

      const res = await cachedJson<MdFeedResponse>(url);
      const batch = res.data ?? [];

      for (const chapter of batch) {
        // Keep external (externally hosted / 0-page) chapters in the list,
        // flagged external: true — the details page shows them greyed with
        // an "External" chip instead of pretending the title has no
        // chapters. They are excluded from unread counts, Continue/Start
        // and downloads.
        all.push(mapChapter(chapter));
      }

      if (
        batch.length === 0 ||
        all.length >= (res.total ?? 0) ||
        batch.length < FEED_LIMIT
      ) {
        break;
      }

      offset += FEED_LIMIT;
    }

    return all;
  },

  async getPageList(chapterId: string): Promise<MangaPage[]> {
    const res = await cachedJson<MdAtHome>(
      `${BASE}/at-home/server/${chapterId}`,
    );
    const baseUrl = res.baseUrl;
    const hash = res.chapter?.hash;
    const files = res.chapter?.data ?? [];

    if (!baseUrl || !hash) {
      throw new Error('MangaDex did not return page data for this chapter');
    }

    // Do not return image URLs on hosts outside this adapter's allowlist.
    // At-home nodes live on rotating *.mangadex.network hosts (verified live
    // 2026-11-05), so allow the mangadex.org / mangadex.network domains.
    const pageHost = new URL(baseUrl);
    const host = pageHost.hostname;
    const hostAllowed =
      pageHost.protocol === 'https:' &&
      (host === 'mangadex.org' ||
        host.endsWith('.mangadex.org') ||
        host === 'mangadex.network' ||
        host.endsWith('.mangadex.network'));
    if (!hostAllowed) {
      throw new Error('MangaDex returned a page host that is not allowed');
    }

    return files.map((f) => ({
      imageUrl: cdnUrl(`${baseUrl}/data/${hash}/${f}`),
    }));
  },
};
