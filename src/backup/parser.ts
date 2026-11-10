import { ProtoReader, readPackedVarints } from './proto';
import { toBase64 } from '../lib/bytes';
import type { ParsedBackup, ParsedCategory, ParsedChapter, ParsedExtensionStore, ParsedHistory, ParsedManga, ParsedPreference, ParsedSource, ParsedSourcePreferences, ParsedTracking } from './models';

type Field = (reader: ProtoReader) => void;
function message(bytes: Uint8Array, fields: Record<number, [number, Field]>): number {
  const reader = new ProtoReader(bytes);
  let unknown = 0;
  while (!reader.done) {
    const [field, wire] = reader.readTag();
    const handler = fields[field];
    if (handler && handler[0] === wire) handler[1](reader);
    else { reader.skipField(wire); unknown++; }
  }
  return unknown;
}
function longNumber(reader: ProtoReader): number {
  const value = Number(reader.readInt64());
  if (!Number.isSafeInteger(value)) throw new Error('A numeric backup value exceeds the supported range');
  return value;
}
const string = (assign: (value: string) => void): [number, Field] => [2, r => assign(r.readString())];
const long = (assign: (value: number) => void): [number, Field] => [0, r => assign(longNumber(r))];
const int = (assign: (value: number) => void): [number, Field] => [0, r => assign(r.readInt32())];
const bool = (assign: (value: boolean) => void): [number, Field] => [0, r => assign(r.readVarint() !== 0n)];
const float = (assign: (value: number) => void): [number, Field] => [5, r => assign(r.readFloat32())];
const bytes = (assign: (value: string) => void): [number, Field] => [2, r => assign(toBase64(r.readBytes()))];

function parseChapter(data: Uint8Array): ParsedChapter {
  const c: ParsedChapter = { url: '', name: '', scanlator: '', read: false, bookmark: false, lastPageRead: 0, dateFetch: 0, dateUpload: 0, chapterNumber: 0, sourceOrder: 0, memo: '' };
  message(data, {
    1: string(v => c.url = v), 2: string(v => c.name = v), 3: string(v => c.scanlator = v),
    4: bool(v => c.read = v), 5: bool(v => c.bookmark = v),
    6: long(v => c.lastPageRead = Math.max(0, Math.min(v, 2147483647))),
    7: long(v => c.dateFetch = v), 8: long(v => c.dateUpload = v),
    9: float(v => c.chapterNumber = v), 10: long(v => c.sourceOrder = v), 13: bytes(v => c.memo = v),
  });
  return c;
}
function parseHistory(data: Uint8Array): ParsedHistory {
  const h: ParsedHistory = { url: '', lastRead: 0, readDuration: 0 };
  message(data, { 1: string(v => h.url = v), 2: long(v => h.lastRead = v), 3: long(v => h.readDuration = v) });
  return h;
}
function parseTracking(data: Uint8Array): ParsedTracking {
  const t: ParsedTracking = { syncId: 0, libraryId: '0', mediaId: '0', mediaIdInt: 0, trackingUrl: '', title: '', lastChapterRead: 0, totalChapters: 0, score: 0, status: 0, startedReadingDate: 0, finishedReadingDate: 0, private: false };
  message(data, {
    1: int(v => t.syncId = v), 2: [0, r => t.libraryId = r.readInt64().toString()], 3: int(v => t.mediaIdInt = v),
    4: string(v => t.trackingUrl = v), 5: string(v => t.title = v), 6: float(v => t.lastChapterRead = v),
    7: int(v => t.totalChapters = v), 8: float(v => t.score = v), 9: int(v => t.status = v),
    10: long(v => t.startedReadingDate = v), 11: long(v => t.finishedReadingDate = v),
    12: bool(v => t.private = v), 100: [0, r => t.mediaId = r.readInt64().toString()],
  });
  return t;
}
function parseManga(data: Uint8Array): ParsedManga {
  const m: ParsedManga = {
    source: 0n, url: '', title: '', artist: '', author: '', description: '', genres: [], status: 0,
    thumbnailUrl: '', dateAdded: 0, viewer: 0, viewerFlags: null, chapterFlags: 0,
    chapters: [], categories: [], history: [], tracking: [], favorite: true, updateStrategy: 0,
    favoriteModifiedAt: 0, excludedScanlators: [], notes: '', initialized: false, memo: '', nextUpdate: 0,
  };
  // Repeated Long can be packed or unpacked depending on the serializer version.
  const r = new ProtoReader(data);
  const fields: Record<number, [number, Field]> = {
    1: [0, r => m.source = r.readInt64()], 2: string(v => m.url = v), 3: string(v => m.title = v),
    4: string(v => m.artist = v), 5: string(v => m.author = v), 6: string(v => m.description = v),
    7: string(v => m.genres.push(v)), 8: int(v => m.status = v), 9: string(v => m.thumbnailUrl = v),
    13: long(v => m.dateAdded = v), 14: int(v => m.viewer = v),
    16: [2, r => m.chapters.push(parseChapter(r.readBytes()))],
    18: [2, r => m.tracking.push(parseTracking(r.readBytes()))],
    100: bool(v => m.favorite = v), 101: int(v => m.chapterFlags = v),
    102: [2, r => m.history.push(parseHistory(r.readBytes()))],
    103: int(v => m.viewerFlags = v), 104: [2, r => m.history.push(parseHistory(r.readBytes()))],
    105: int(v => m.updateStrategy = v), 107: long(v => m.favoriteModifiedAt = v),
    108: string(v => m.excludedScanlators.push(v)), 110: string(v => m.notes = v),
    111: bool(v => m.initialized = v), 112: bytes(v => m.memo = v), 113: long(v => m.nextUpdate = v),
  };
  while (!r.done) {
    const [field, wire] = r.readTag();
    if (field === 17 && wire === 0) m.categories.push(r.readInt64());
    else if (field === 17 && wire === 2) m.categories.push(...readPackedVarints(r.readBytes()));
    else {
      const handler = fields[field];
      if (handler && handler[0] === wire) handler[1](r);
      else r.skipField(wire);
    }
  }
  if (!m.url) throw new Error(`Missing source URL for ${m.title || 'a manga'}`);
  return m;
}
function parseCategory(data: Uint8Array): ParsedCategory {
  const c: ParsedCategory = { name: '', order: 0n, id: 0n, flags: 0n };
  message(data, { 1: string(v => c.name = v), 2: [0, r => c.order = r.readInt64()], 3: [0, r => c.id = r.readInt64()], 100: [0, r => c.flags = r.readInt64()] });
  return c;
}
function parseSource(data: Uint8Array, legacy = false): ParsedSource {
  const s: ParsedSource = { name: '', sourceId: 0n };
  message(data, legacy
    ? { 1: [0, r => s.sourceId = r.readInt64()], 2: string(v => s.name = v) }
    : { 1: string(v => s.name = v), 2: [0, r => s.sourceId = r.readInt64()] });
  return s;
}
function parsePreference(data: Uint8Array): ParsedPreference {
  const p: ParsedPreference = { key: '', type: '', value: null, rawValue: '' };
  message(data, { 1: string(v => p.key = v), 2: [2, r => {
    const raw = r.readBytes();
    p.rawValue = toBase64(raw);
    let payload: Uint8Array = new Uint8Array();
    message(raw, { 1: string(v => p.type = v), 2: [2, r => payload = r.readBytes()] });
    const type = p.type.split('.').pop();
    const values: string[] = [];
    const decoder: Record<string, [number, Field]> = {
      IntPreferenceValue: int(v => p.value = v), LongPreferenceValue: [0, r => p.value = r.readInt64().toString()],
      FloatPreferenceValue: float(v => p.value = v), StringPreferenceValue: string(v => p.value = v),
      BooleanPreferenceValue: bool(v => p.value = v), StringSetPreferenceValue: string(v => values.push(v)),
    };
    if (type && decoder[type]) message(payload, { 1: decoder[type]! });
    if (type === 'StringSetPreferenceValue') p.value = values;
  }] });
  return p;
}
function parseSourcePreferences(data: Uint8Array): ParsedSourcePreferences {
  const p: ParsedSourcePreferences = { sourceKey: '', prefs: [] };
  message(data, { 1: string(v => p.sourceKey = v), 2: [2, r => p.prefs.push(parsePreference(r.readBytes()))] });
  return p;
}
function parseExtensionStore(data: Uint8Array): ParsedExtensionStore {
  const s: ParsedExtensionStore = { indexUrl: '', name: '', badgeLabel: '', signingKey: '', contactWebsite: '', contactDiscord: '', isLegacy: false, extensionListUrl: '' };
  message(data, { 1: string(v => s.indexUrl = v), 2: string(v => s.name = v), 3: string(v => s.badgeLabel = v), 4: string(v => s.contactWebsite = v), 5: string(v => s.signingKey = v), 6: string(v => s.contactDiscord = v), 7: bool(v => s.isLegacy = v), 8: string(v => s.extensionListUrl = v) });
  return s;
}

export function parseTachibk(data: Uint8Array): ParsedBackup {
  if (!data.length) throw new Error('This backup is empty (0 bytes). Choose the original .tachibk file.');
  const b: ParsedBackup = { manga: [], categories: [], sources: [], preferences: [], sourcePreferences: [], extensionStores: [], unknownFields: 0 };
  b.unknownFields = message(data, {
    1: [2, r => b.manga.push(parseManga(r.readBytes()))],
    2: [2, r => b.categories.push(parseCategory(r.readBytes()))],
    100: [2, r => b.sources.push(parseSource(r.readBytes(), true))],
    101: [2, r => b.sources.push(parseSource(r.readBytes()))],
    104: [2, r => b.preferences.push(parsePreference(r.readBytes()))],
    105: [2, r => b.sourcePreferences.push(parseSourcePreferences(r.readBytes()))],
    106: [2, r => b.extensionStores.push(parseExtensionStore(r.readBytes()))],
  });
  if (!b.manga.length && !b.categories.length && !b.preferences.length) throw new Error('No Mihon library data was found in this file');
  return b;
}
