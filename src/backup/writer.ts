import type { ParsedBackup, ParsedChapter, ParsedManga, ParsedPreference, ParsedTracking } from './models';
import { fromBase64 } from '../lib/bytes';

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function varint(value: bigint | number): Uint8Array {
  let remaining = BigInt.asUintN(64, BigInt(value));
  const bytes: number[] = [];
  do { const byte = Number(remaining & 127n); remaining >>= 7n; bytes.push(byte | (remaining ? 128 : 0)); } while (remaining);
  return new Uint8Array(bytes);
}
function integer(field: number, value: bigint | number): Uint8Array { return concat([varint(field * 8), varint(value)]); }
function bytes(field: number, value: Uint8Array): Uint8Array { return concat([varint(field * 8 + 2), varint(value.length), value]); }
function string(field: number, value: string): Uint8Array { return bytes(field, new TextEncoder().encode(value)); }
function float(field: number, value: number): Uint8Array {
  if (!Number.isFinite(value)) throw new Error('Cannot export a non-finite backup number');
  const output = new Uint8Array(4);
  new DataView(output.buffer).setFloat32(0, value, true);
  return concat([varint(field * 8 + 5), output]);
}
const memo = (field: number, value: string) => value ? bytes(field, fromBase64(value)) : new Uint8Array();

function chapter(c: ParsedChapter): Uint8Array {
  return concat([string(1, c.url), string(2, c.name), string(3, c.scanlator), integer(4, Number(c.read)), integer(5, Number(c.bookmark)),
    integer(6, c.lastPageRead), integer(7, c.dateFetch), integer(8, c.dateUpload), float(9, c.chapterNumber), integer(10, c.sourceOrder), memo(13, c.memo)]);
}
function tracking(t: ParsedTracking): Uint8Array {
  return concat([integer(1, t.syncId), integer(2, BigInt(t.libraryId)), integer(3, t.mediaIdInt), string(4, t.trackingUrl), string(5, t.title),
    float(6, t.lastChapterRead), integer(7, t.totalChapters), float(8, t.score), integer(9, t.status), integer(10, t.startedReadingDate),
    integer(11, t.finishedReadingDate), integer(12, Number(t.private)), integer(100, BigInt(t.mediaId))]);
}
function manga(m: ParsedManga): Uint8Array {
  return concat([integer(1, m.source), string(2, m.url), string(3, m.title), string(4, m.artist), string(5, m.author), string(6, m.description),
    ...m.genres.map(genre => string(7, genre)), integer(8, m.status), string(9, m.thumbnailUrl), integer(13, m.dateAdded), integer(14, m.viewer),
    ...m.chapters.map(c => bytes(16, chapter(c))), ...m.categories.map(category => integer(17, category)), ...m.tracking.map(t => bytes(18, tracking(t))),
    integer(100, Number(m.favorite)), integer(101, m.chapterFlags),
    ...(m.viewerFlags === null ? [] : [integer(103, m.viewerFlags)]),
    ...m.history.map(h => bytes(104, concat([string(1, h.url), integer(2, h.lastRead), integer(3, h.readDuration)]))),
    integer(105, m.updateStrategy), integer(107, m.favoriteModifiedAt), ...m.excludedScanlators.map(scanlator => string(108, scanlator)),
    string(110, m.notes), integer(111, Number(m.initialized)), memo(112, m.memo), integer(113, m.nextUpdate)]);
}
function preference(p: ParsedPreference): Uint8Array {
  if (p.rawValue) return concat([string(1, p.key), bytes(2, fromBase64(p.rawValue))]);
  const kind = p.type.split('.').at(-1);
  let value: Uint8Array;
  if (kind === 'StringPreferenceValue') value = string(1, String(p.value ?? ''));
  else if (kind === 'BooleanPreferenceValue') value = integer(1, Number(p.value === true));
  else if (kind === 'StringSetPreferenceValue' && Array.isArray(p.value)) value = concat(p.value.map(v => string(1, v)));
  else if (kind === 'FloatPreferenceValue') value = float(1, Number(p.value));
  else if (kind === 'IntPreferenceValue' || kind === 'LongPreferenceValue') value = integer(1, BigInt(String(p.value)));
  else throw new Error(`Unsupported preference type: ${p.type}`);
  return concat([string(1, p.key), bytes(2, concat([string(1, p.type), bytes(2, value)]))]);
}

// Field numbers are from Mihon v0.21.3 @ProtoNumber declarations. This
// emits a new backup of current state; original archives remain unchanged.
export function encodeTachibk(backup: ParsedBackup): Uint8Array {
  return concat([
    ...backup.manga.map(m => bytes(1, manga(m))),
    ...backup.categories.map(c => bytes(2, concat([string(1, c.name), integer(2, c.order), integer(3, c.id), integer(100, c.flags)]))),
    ...backup.sources.map(s => bytes(101, concat([string(1, s.name), integer(2, s.sourceId)]))),
    ...backup.preferences.map(p => bytes(104, preference(p))),
    ...backup.sourcePreferences.map(s => bytes(105, concat([string(1, s.sourceKey), ...s.prefs.map(p => bytes(2, preference(p)))]))),
    ...backup.extensionStores.map(s => bytes(106, concat([string(1, s.indexUrl), string(2, s.name), string(3, s.badgeLabel), string(4, s.contactWebsite),
      string(5, s.signingKey), string(6, s.contactDiscord), integer(7, Number(s.isLegacy)), string(8, s.extensionListUrl)]))),
  ]);
}
