// Independent wire fixtures from upstream @ProtoNumber declarations.
// No user's library or chapter files are included in these fixtures.
import { gzipSync } from 'fflate';
export const EXACT_SOURCE = 9223372036854775806n;
export const NEGATIVE_SOURCE = -4758858684982406533n;
export const DEX_SOURCE = 2499283573021220255n;
export const DEX_MANGA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const READ_AT = 1794000000000;
export function concat(...values: Uint8Array[]) { const out = new Uint8Array(values.reduce((n, v) => n + v.length, 0)); let i = 0; for (const v of values) { out.set(v, i); i += v.length; } return out; }
export function varint(value: bigint | number) { let v = BigInt.asUintN(64, BigInt(value)); const result: number[] = []; do { const byte = Number(v & 127n); v >>= 7n; result.push(byte | (v ? 128 : 0)); } while (v); return new Uint8Array(result); }
export function integer(field: number, value: bigint | number) { return concat(varint(field * 8), varint(value)); }
export function bytes(field: number, value: Uint8Array) { return concat(varint(field * 8 + 2), varint(value.length), value); }
export function string(field: number, value: string) { return bytes(field, new TextEncoder().encode(value)); }
export function float(field: number, value: number) { const raw = new Uint8Array(4); new DataView(raw.buffer).setFloat32(0, value, true); return concat(varint(field * 8 + 5), raw); }
function category(name: string, order: number, id: number) { return bytes(2, concat(string(1, name), integer(2, order), integer(3, id), integer(100, 64))); }
export function preference(key: string, type: string, payload: Uint8Array) { return bytes(104, concat(string(1, key), bytes(2, concat(string(1, 'eu.kanade.tachiyomi.data.backup.models.' + type), bytes(2, payload))))); }
export function chapter(url = '/chapter/2', read = false, page = 3) { return concat(string(1, url), string(2, url.endsWith('2') ? 'Chapter 2' : 'Chapter 1'), string(3, 'Test group'), integer(4, Number(read)), integer(5, 1), integer(6, page), integer(7, READ_AT - 1000), integer(8, READ_AT - 5000), float(9, url.endsWith('2') ? 2 : 1), integer(10, url.endsWith('2') ? 0 : 1), bytes(13, new TextEncoder().encode('{"chapterNote":"retained"}'))); }
export function schemaBackup(packed = true) {
  const tracking = concat(integer(1, 1), integer(2, EXACT_SOURCE), integer(3, 1234), string(4, 'https://tracker.example/1234'), string(5, 'Tracked title'), float(6, 12.5), integer(7, 90), float(8, 9.5), integer(9, 2), integer(10, READ_AT - 10000), integer(11, READ_AT), integer(12, 1), integer(100, EXACT_SOURCE - 1n));
  const memberships = packed ? bytes(17, concat(varint(5), varint(12))) : concat(integer(17, 5), integer(17, 12));
  const manga = concat(integer(1, EXACT_SOURCE), string(2, '/series/hero'), string(3, 'Schema Hero'), string(4, 'Artist'), string(5, 'Author'), string(6, 'A complete schema fixture.'), string(7, 'Action'), string(7, 'Adventure'), integer(8, 1), string(9, ''), integer(13, READ_AT - 86400000), integer(103, 2), integer(101, 20), bytes(16, chapter('/chapter/1', true, 7)), bytes(16, chapter()), memberships, bytes(18, tracking), bytes(104, concat(string(1, '/chapter/2'), integer(2, READ_AT), integer(3, 45000))), string(108, 'Excluded group'), string(110, 'Saved notes'), integer(111, 1), bytes(112, new TextEncoder().encode('{"custom":"retained"}')), integer(113, READ_AT + 10000));
  const dex = concat(integer(1, DEX_SOURCE), string(2, '/manga/' + DEX_MANGA), string(3, 'MangaDex fixture'), bytes(16, chapter('/chapter/11111111-2222-3333-4444-555555555555')));
  const nonFavorite = concat(integer(1, NEGATIVE_SOURCE), string(2, '/series/archived'), string(3, 'Archived title'), integer(100, 0));
  const boolPref = concat(string(1, 'pref_data_saver'), bytes(2, concat(string(1, 'eu.kanade.tachiyomi.data.backup.models.BooleanPreferenceValue'), bytes(2, integer(1, 1)))));
  return concat(bytes(1, manga), bytes(1, dex), bytes(1, nonFavorite), category('Reading', 5, 9), category('ID collision', 9, 5), category('Shelf Two', 12, 88), bytes(101, concat(string(1, 'Exact ID source'), integer(2, EXACT_SOURCE))), bytes(101, concat(string(1, 'MangaDex (EN)'), integer(2, DEX_SOURCE))), preference('pref_default_viewer_key', 'IntPreferenceValue', integer(1, 2)), preference('languages', 'StringSetPreferenceValue', concat(string(1, 'en'), string(1, 'es'))), bytes(104, boolPref), bytes(105, concat(string(1, 'source_' + EXACT_SOURCE), bytes(2, boolPref))), bytes(106, concat(string(1, 'https://extensions.example/index.min.json'), string(2, 'Extension store'), string(3, 'Test'), string(4, 'https://example.com'), string(5, 'signing-key-fixture'), string(6, 'https://discord.example'), integer(7, 1), string(8, 'https://extensions.example/index.json'))), string(999, 'future-field'));
}
export function schemaFile(packed = true) { return new File([gzipSync(schemaBackup(packed))], 'schema-fixture.tachibk', { type: 'application/gzip' }); }
export function svgPage(label: string, width = 800, height = 1200) { return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><rect width="100%" height="100%" fill="#e8dfff"/><text x="40" y="80" fill="#302343" font-size="32">' + label + '</text></svg>'; }
