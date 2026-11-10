import { describe, expect, it, vi } from 'vitest';
import { gunzipIfNeeded } from '../src/backup/compression';
import { parseTachibk } from '../src/backup/parser';
import { inspectTachibkFile, restoreTachibk } from '../src/backup/tachibk';
import { ProtoReader } from '../src/backup/proto';
import { getDB, getLibraryEntry, getManga, getChapterState, getArchives, addToLibrary, patchChapterState, downloadRemovalKey, removeFromLibrary } from '../src/lib/db';
import { loadSettings } from '../src/lib/settings';
import { EXACT_SOURCE, NEGATIVE_SOURCE, DEX_MANGA, READ_AT, schemaBackup, schemaFile, integer, string, concat, bytes, varint, float } from './fixtures/mihon';

const key = EXACT_SOURCE + '::/series/hero';
describe('Mihon backup wire compatibility', () => {
  it('parses signed and exact 64-bit source/tracker IDs, bookmarks, notes, preferences, history, and extension stores', () => {
    const backup = parseTachibk(schemaBackup());
    const manga = backup.manga[0]!;
    expect(manga.source).toBe(EXACT_SOURCE);
    expect(backup.manga[2]!.source).toBe(NEGATIVE_SOURCE);
    expect(manga.chapters[0]).toMatchObject({ bookmark: true, read: true, lastPageRead: 7, scanlator: 'Test group', sourceOrder: 1, dateFetch: READ_AT - 1000 });
    expect(manga.notes).toBe('Saved notes');
    expect(manga.viewerFlags).toBe(2);
    expect(manga.tracking[0]).toMatchObject({ libraryId: EXACT_SOURCE.toString(), mediaId: (EXACT_SOURCE - 1n).toString(), score: 9.5, lastChapterRead: 12.5, private: true });
    expect(manga.history[0]).toEqual({ url: '/chapter/2', lastRead: READ_AT, readDuration: 45000 });
    expect(backup.preferences.map(p => p.value)).toEqual([2, ['en', 'es'], true]);
    expect(backup.sourcePreferences[0]!.prefs[0]!.value).toBe(true);
    expect(backup.extensionStores[0]).toMatchObject({ signingKey: 'signing-key-fixture', contactWebsite: 'https://example.com', isLegacy: true });
    expect(backup.unknownFields).toBe(1);
  });
  it('accepts packed and unpacked category memberships and absent favorite defaults', () => {
    expect(parseTachibk(schemaBackup(false))).toEqual(parseTachibk(schemaBackup(true)));
    expect(parseTachibk(bytes(1, concat(integer(1, EXACT_SOURCE), string(2, '/minimal')))).manga[0]!.favorite).toBe(true);
  });
  it('decompresses gzip in native and older WebKit fallback paths', async () => {
    const file = schemaFile();
    const expected = schemaBackup();
    expect(await gunzipIfNeeded(new Uint8Array(await file.arrayBuffer()))).toEqual(expected);
    vi.stubGlobal('DecompressionStream', undefined);
    expect(await gunzipIfNeeded(new Uint8Array(await file.arrayBuffer()))).toEqual(expected);
    vi.unstubAllGlobals();
  });
  it('rejects empty, truncated, invalid tags, overflowed varints, and non-finite numbers', async () => {
    expect(() => parseTachibk(new Uint8Array())).toThrow(/empty/);
    expect(() => parseTachibk(new Uint8Array([10, 127, 42]))).toThrow(/Truncated/);
    expect(() => parseTachibk(new Uint8Array([0]))).toThrow(/tag/);
    expect(() => new ProtoReader(new Uint8Array([...Array(9).fill(255), 2])).readVarint()).toThrow(/64 bits/);
    expect(() => parseTachibk(bytes(1, concat(string(2, '/test'), bytes(16, float(9, NaN)))))).toThrow(/Invalid number/);
    await expect(inspectTachibkFile(new File([], 'empty.tachibk'))).rejects.toThrow(/0 bytes/);
    await expect(gunzipIfNeeded(new Uint8Array([31, 139, 0, 0]))).rejects.toThrow(/decompress/i);
    expect(new ProtoReader(varint(-1)).readInt64()).toBe(-1n);
  });
  it('inspects a valid backup whose picker-reported size is 0', async () => {
    // Android content:// pickers can hand back a File whose size reads 0
    // while its bytes are intact — the gate must trust the bytes, not size.
    const file = schemaFile();
    Object.defineProperty(file, 'size', { get: () => 0 });
    const preview = await inspectTachibkFile(file);
    expect(preview.mangaCount).toBe(3);
  });
});
describe('transactional Mihon migration', () => {
  it('uses category order before colliding category IDs, restores all memberships and retains original bytes', async () => {
    const file = schemaFile();
    const preview = await inspectTachibkFile(file);
    expect(preview).toMatchObject({ libraryCount: 2, chapterCount: 3, bookmarkCount: 3, trackingCount: 1 });
    const result = await restoreTachibk(preview, { restorePreferences: true });
    expect(result).toMatchObject({ mangaCount: 3, libraryCount: 2, mangadexMatched: 1 });
    expect((await getLibraryEntry(key))?.categories).toEqual(['Reading', 'Shelf Two']);
    expect((await getLibraryEntry(key))?.categories).not.toContain('ID collision');
    expect((await getManga(key))?.readerMode).toBe('rtl');
    expect((await getManga(key))?.mihon?.tracking).toHaveLength(1);
    expect((await getManga('mangadex::' + DEX_MANGA))?.sourceAvailable).toBe(false);
    expect(await getLibraryEntry(NEGATIVE_SOURCE + '::/series/archived')).toBeUndefined();
    expect(loadSettings().readerMode).toBe('rtl');
    const archives = await getArchives();
    expect(archives).toHaveLength(1);
    expect(new Uint8Array(await archives[0]!.bytes.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()));
  });
  it('merges repeated imports and preserves newer local progress, explicit unread marks, and categories', async () => {
    const preview = await inspectTachibkFile(schemaFile());
    await restoreTachibk(preview);
    await addToLibrary(key, ['Personal']);
    await patchChapterState(key + '::/chapter/2', key, { lastPage: 20, lastReadAt: READ_AT + 10000, read: true, pageOffset: .35 });
    await patchChapterState(key + '::/chapter/1', key, { read: false, lastPage: 0, lastReadAt: READ_AT + 10000 });
    await restoreTachibk(preview);
    expect(await getChapterState(key + '::/chapter/2')).toMatchObject({ lastPage: 20, read: true, bookmark: true, pageOffset: .35 });
    expect(await getChapterState(key + '::/chapter/1')).toMatchObject({ lastPage: 0, read: false });
    expect((await getLibraryEntry(key))?.categories).toEqual(['Reading', 'Shelf Two', 'Personal']);
    expect(await getArchives()).toHaveLength(1);
  });
  it('allows a removed title to be re-added by an Android import', async () => {
    const preview = await inspectTachibkFile(schemaFile());
    await restoreTachibk(preview);
    await removeFromLibrary(key);
    expect(await (await getDB()).get('metadata', downloadRemovalKey(key))).toBeDefined();
    await restoreTachibk(preview);
    expect(await getLibraryEntry(key)).toBeDefined();
    expect(await (await getDB()).get('metadata', downloadRemovalKey(key))).toBeUndefined();
  });
  it('rolls back the entire import if restoration fails mid-transaction', async () => {
    const preview = await inspectTachibkFile(schemaFile());
    await expect(restoreTachibk(preview, { onProgress() { throw new Error('Simulated storage failure'); } })).rejects.toThrow('Simulated storage failure');
    const db = await getDB();
    for (const name of ['manga', 'chapterState', 'library', 'categories', 'archives'] as const) expect(await db.count(name)).toBe(0);
  });
});
