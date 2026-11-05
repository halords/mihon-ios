import { ProtoReader, readPackedVarints } from './proto';
import { chapterKey, mangaKey } from '../sources/Source';
import type { MangaStatus, SChapter, SManga } from '../sources/Source';
import { getSource } from '../sources/index';
import { coverArt } from '../sources/svgArt';
import {
  addToLibrary,
  patchChapterState,
  putChapterMetas,
  putHistory,
  putManga,
} from '../lib/db';

export interface ParsedChapter {
  url: string;
  name: string;
  read: boolean;
  lastPageRead: number;
  dateUpload: number;
  chapterNumber: number;
}

export interface ParsedHistory {
  url: string;
  lastRead: number;
}

export interface ParsedManga {
  source: bigint;
  url: string;
  title: string;
  author?: string;
  artist?: string;
  description: string;
  genres: string[];
  status: number;
  thumbnailUrl?: string;
  dateAdded: number;
  chapters: ParsedChapter[];
  categories: bigint[];
  history: ParsedHistory[];
}

export interface ParsedCategory {
  name: string;
  order: bigint;
  id: bigint;
}

export interface ParsedSource {
  name: string;
  sourceId: bigint;
}

export interface ParsedBackup {
  manga: ParsedManga[];
  categories: ParsedCategory[];
  sources: ParsedSource[];
}

export interface TachibkImportResult {
  mangaCount: number;
  chapterCount: number;
  categoryCount: number;
  historyCount: number;
  mangadexMatched: number;
}

function parseSource(bytes: Uint8Array): ParsedSource {
  const r = new ProtoReader(bytes);
  const source: ParsedSource = { name: '', sourceId: 0n };

  while (!r.done) {
    const [field, wire] = r.readTag();
    switch (field) {
      case 1:
        if (wire === 2) source.name = r.readString();
        else r.skipField(wire);
        break;
      case 2:
        if (wire === 0) source.sourceId = r.readVarint();
        else r.skipField(wire);
        break;
      default:
        r.skipField(wire);
    }
  }

  return source;
}

function parseCategory(bytes: Uint8Array): ParsedCategory {
  const r = new ProtoReader(bytes);
  const category: ParsedCategory = { name: '', order: 0n, id: 0n };

  while (!r.done) {
    const [field, wire] = r.readTag();
    switch (field) {
      case 1:
        if (wire === 2) category.name = r.readString();
        else r.skipField(wire);
        break;
      case 2:
        if (wire === 0) category.order = r.readVarint();
        else r.skipField(wire);
        break;
      case 3:
        if (wire === 0) category.id = r.readVarint();
        else r.skipField(wire);
        break;
      default:
        r.skipField(wire);
    }
  }

  return category;
}

function parseChapter(bytes: Uint8Array): ParsedChapter {
  const r = new ProtoReader(bytes);
  const chapter: ParsedChapter = {
    url: '',
    name: '',
    read: false,
    lastPageRead: 0,
    dateUpload: 0,
    chapterNumber: 0,
  };

  while (!r.done) {
    const [field, wire] = r.readTag();
    switch (field) {
      case 1:
        if (wire === 2) chapter.url = r.readString();
        else r.skipField(wire);
        break;
      case 2:
        if (wire === 2) chapter.name = r.readString();
        else r.skipField(wire);
        break;
      case 4:
        if (wire === 0) chapter.read = Number(r.readVarint()) !== 0;
        else r.skipField(wire);
        break;
      case 6:
        if (wire === 0) chapter.lastPageRead = Number(r.readVarint());
        else r.skipField(wire);
        break;
      case 8:
        if (wire === 0) chapter.dateUpload = Number(r.readVarint());
        else r.skipField(wire);
        break;
      case 9:
        if (wire === 5) chapter.chapterNumber = r.readFloat32();
        else r.skipField(wire);
        break;
      default:
        r.skipField(wire);
    }
  }

  return chapter;
}

function parseHistory(bytes: Uint8Array): ParsedHistory {
  const r = new ProtoReader(bytes);
  const history: ParsedHistory = { url: '', lastRead: 0 };

  while (!r.done) {
    const [field, wire] = r.readTag();
    switch (field) {
      case 1:
        if (wire === 2) history.url = r.readString();
        else r.skipField(wire);
        break;
      case 2:
        if (wire === 0) history.lastRead = Number(r.readVarint());
        else r.skipField(wire);
        break;
      default:
        r.skipField(wire);
    }
  }

  return history;
}

function parseManga(bytes: Uint8Array): ParsedManga {
  const r = new ProtoReader(bytes);
  const manga: ParsedManga = {
    source: 0n,
    url: '',
    title: '',
    author: '',
    artist: '',
    description: '',
    genres: [],
    status: 0,
    thumbnailUrl: '',
    dateAdded: 0,
    chapters: [],
    categories: [],
    history: [],
  };

  while (!r.done) {
    const [field, wire] = r.readTag();
    switch (field) {
      case 1:
        if (wire === 0) manga.source = r.readVarint();
        else r.skipField(wire);
        break;
      case 2:
        if (wire === 2) manga.url = r.readString();
        else r.skipField(wire);
        break;
      case 3:
        if (wire === 2) manga.title = r.readString();
        else r.skipField(wire);
        break;
      case 4:
        if (wire === 2) manga.artist = r.readString();
        else r.skipField(wire);
        break;
      case 5:
        if (wire === 2) manga.author = r.readString();
        else r.skipField(wire);
        break;
      case 6:
        if (wire === 2) manga.description = r.readString();
        else r.skipField(wire);
        break;
      case 7:
        if (wire === 2) manga.genres.push(r.readString());
        else r.skipField(wire);
        break;
      case 8:
        if (wire === 0) manga.status = Number(r.readVarint());
        else r.skipField(wire);
        break;
      case 9:
        if (wire === 2) manga.thumbnailUrl = r.readString();
        else r.skipField(wire);
        break;
      case 13:
        if (wire === 0) manga.dateAdded = Number(r.readVarint());
        else r.skipField(wire);
        break;
      case 16:
        if (wire === 2) manga.chapters.push(parseChapter(r.readBytes()));
        else r.skipField(wire);
        break;
      case 17:
        if (wire === 0) manga.categories.push(r.readVarint());
        else if (wire === 2) {
          manga.categories.push(...readPackedVarints(r.readBytes()));
        } else {
          r.skipField(wire);
        }
        break;
      case 104:
        if (wire === 2) manga.history.push(parseHistory(r.readBytes()));
        else r.skipField(wire);
        break;
      default:
        r.skipField(wire);
    }
  }

  return manga;
}

export function parseTachibk(bytes: Uint8Array): ParsedBackup {
  const r = new ProtoReader(bytes);
  const backup: ParsedBackup = {
    manga: [],
    categories: [],
    sources: [],
  };

  while (!r.done) {
    const [field, wire] = r.readTag();
    switch (field) {
      case 1:
        if (wire === 2) backup.manga.push(parseManga(r.readBytes()));
        else r.skipField(wire);
        break;
      case 2:
        if (wire === 2) backup.categories.push(parseCategory(r.readBytes()));
        else r.skipField(wire);
        break;
      case 101:
        if (wire === 2) backup.sources.push(parseSource(r.readBytes()));
        else r.skipField(wire);
        break;
      default:
        r.skipField(wire);
    }
  }

  return backup;
}

export async function gunzipIfNeeded(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot decompress .tachibk backups.');
    }

    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  }

  return bytes;
}

const MANGADEX_MIHON_ID = '2499283573021220255';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractUuid(s: string): string | null {
  const m = UUID_RE.exec(s);
  return m ? m[0] : null;
}

function mapStatus(status: number): MangaStatus {
  switch (status) {
    case 1:
      return 'Ongoing';
    case 2:
      return 'Completed';
    case 6:
      return 'On Hold';
    default:
      return 'Unknown';
  }
}

export async function importTachibkFile(
  file: Blob,
): Promise<TachibkImportResult> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const bytes = await gunzipIfNeeded(raw);
  const backup = parseTachibk(bytes);

  if (backup.manga.length === 0) {
    throw new Error('No manga found in this backup file.');
  }

  const sourceNameById = new Map<bigint, string>(
    backup.sources.map(s => [s.sourceId, s.name]),
  );
  const categoryById = new Map<bigint, ParsedCategory>(
    backup.categories.map(c => [c.id, c]),
  );
  const categoryByOrder = new Map<bigint, ParsedCategory>(
    backup.categories.map(c => [c.order, c]),
  );

  const counters: TachibkImportResult = {
    mangaCount: 0,
    chapterCount: 0,
    categoryCount: backup.categories.length,
    historyCount: 0,
    mangadexMatched: 0,
  };

  for (const pm of backup.manga) {
    const rawSourceId = pm.source.toString();
    const sourceName = sourceNameById.get(pm.source);

    let sourceId = rawSourceId;
    let mangaId = pm.url;
    let available = false;

    const isDex =
      rawSourceId === MANGADEX_MIHON_ID ||
      (sourceName !== undefined && /^mangadex/i.test(sourceName));

    if (isDex) {
      const uuid = extractUuid(pm.url);
      if (uuid) {
        sourceId = 'mangadex';
        mangaId = uuid;
        available = true;
        counters.mangadexMatched += 1;
      }
    }

    if (!available) available = getSource(sourceId) !== undefined;

    const title = pm.title !== '' ? pm.title : pm.url;
    const hue =
      [...pm.url].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
    const smanga: SManga = {
      id: mangaId,
      sourceId,
      title,
      author: pm.author,
      artist: pm.artist,
      status: mapStatus(pm.status),
      description: pm.description,
      genres: pm.genres,
      coverUrl: pm.thumbnailUrl
        ? pm.thumbnailUrl
        : coverArt(title, pm.author, hue),
    };

    await putManga(smanga, available);
    const key = mangaKey(sourceId, mangaId);

    const pairs = pm.chapters.map(pc => {
      const cid =
        isDex && available ? (extractUuid(pc.url) ?? pc.url) : pc.url;
      const chapter: SChapter = {
        id: cid,
        mangaId,
        name: pc.name !== '' ? pc.name : `Chapter ${pc.chapterNumber}`,
        number: pc.chapterNumber,
        dateUpload: pc.dateUpload,
      };
      return { pc, chapter };
    });

    if (pairs.length > 0) {
      await putChapterMetas(
        sourceId,
        mangaId,
        pairs.map(p => p.chapter),
      );
    }

    for (const { pc, chapter } of pairs) {
      counters.chapterCount += 1;
      if (pc.read || pc.lastPageRead > 0) {
        await patchChapterState(
          chapterKey(sourceId, mangaId, chapter.id),
          key,
          { read: pc.read, lastPage: pc.lastPageRead },
        );
      }
    }

    let categoryName = 'Default';
    const firstCat =
      pm.categories.length > 0
        ? (categoryById.get(pm.categories[0]!) ??
          categoryByOrder.get(pm.categories[0]!))
        : undefined;

    if (firstCat && firstCat.name !== '') categoryName = firstCat.name;
    await addToLibrary(key, categoryName);

    const byUrl = new Map(pairs.map(p => [p.pc.url, p] as const));
    for (const h of pm.history) {
      const pair = byUrl.get(h.url);
      if (!pair) continue;

      await putHistory({
        key: chapterKey(sourceId, mangaId, pair.chapter.id),
        mangaKey: key,
        mangaTitle: title,
        coverUrl: smanga.coverUrl,
        chapterName: pair.chapter.name,
        page: pair.pc.lastPageRead,
        updatedAt: h.lastRead,
      });
      counters.historyCount += 1;
    }

    counters.mangaCount += 1;
  }

  return counters;
}
