import { expect, it } from 'vitest';
import { encodeTachibk } from '../src/backup/writer';
import { createMihonBackup } from '../src/backup/export';
import { gunzipIfNeeded } from '../src/backup/compression';
import { parseTachibk } from '../src/backup/parser';
import { inspectTachibkFile, restoreTachibk } from '../src/backup/tachibk';
import { addToLibrary, getDB, getManga, patchChapterState, putManga, removeFromLibrary, setLibraryCategory } from '../src/lib/db';
import { saveSettings } from '../src/lib/settings';
import { schemaBackup, schemaFile, EXACT_SOURCE, DEX_SOURCE, READ_AT, DEX_MANGA } from './fixtures/mihon';
import { migrateManga } from '../src/lib/migration';

it('serializes the upstream wire fixture with exact IDs, tracking, preference payloads, memos and stores', () => {
  const original = parseTachibk(schemaBackup());
  expect(parseTachibk(encodeTachibk(original))).toEqual({ ...original, unknownFields: 0 });
});

it('exports current progress, memberships, favorite removals and preferences as a new compressed Mihon backup', async () => {
  const original = schemaFile();
  await restoreTachibk(await inspectTachibkFile(original));
  const key = EXACT_SOURCE + '::/series/hero';
  await patchChapterState(key + '::/chapter/2', key, { lastPage: 19, read: true, bookmark: false });
  await setLibraryCategory(key, ['Shelf Two']);
  await removeFromLibrary('mangadex::' + DEX_MANGA);
  saveSettings({ librarySort: 'read', librarySortDirection: 'descending', readerMode: 'rtl' });
  const exported = await createMihonBackup();
  expect(exported.libraryCount).toBe(1);
  const raw = new Uint8Array(await exported.file.arrayBuffer());
  expect([...raw.slice(0, 2)]).toEqual([31, 139]);
  const backup = parseTachibk(await gunzipIfNeeded(raw));
  const manga = backup.manga.find(m => m.source === EXACT_SOURCE)!;
  expect(manga.chapters.find(c => c.url === '/chapter/2')).toMatchObject({ read: true, bookmark: false, lastPageRead: 19 });
  expect(manga.history[0]).toMatchObject({ lastRead: READ_AT, readDuration: 45000 });
  expect(manga.categories).toEqual([backup.categories.find(c => c.name === 'Shelf Two')!.order]);
  expect(manga.tracking[0]?.libraryId).toBe(EXACT_SOURCE.toString());
  expect(backup.manga.find(m => m.source === DEX_SOURCE)?.favorite).toBe(false);
  expect(backup.preferences.find(p => p.key === 'library_sorting_mode')?.value).toBe('LAST_READ,DESCENDING');
  expect(backup.extensionStores[0]?.signingKey).toBe('signing-key-fixture');
  expect(raw).not.toEqual(new Uint8Array(await original.arrayBuffer()));
  for (const name of (await getDB()).objectStoreNames) await (await getDB()).clear(name);
  await restoreTachibk(await inspectTachibkFile(exported.file));
  expect(await getManga(key)).toBeDefined();
});

it('exports a migrated title with its new source ID and URL instead of its retained original source', async () => {
  await restoreTachibk(await inspectTachibkFile(schemaFile()));
  const key = EXACT_SOURCE + '::/series/hero';
  const manga = { id: '/new/hero', sourceId: '4758858684982406533', sourceName: 'New source', title: 'Migrated Hero', genres: [], description: '', status: 'Ongoing' as const, coverUrl: '' };
  await migrateManga(key, manga, [{ id: '/new/chapter/2', mangaId: manga.id, number: 2, dateUpload: 0, name: 'Chapter 2' }], false);
  const backup = parseTachibk(await gunzipIfNeeded(new Uint8Array(await (await createMihonBackup()).file.arrayBuffer())));
  expect(backup.manga.find(m => m.title === 'Migrated Hero')).toMatchObject({ source: 4758858684982406533n, url: '/new/hero', favorite: true });
});

it('rejects browser-only library sources instead of silently losing titles in an Android export', async () => {
  const key = await putManga({ id: 'demo', sourceId: 'sample', title: 'Demo', description: '', genres: [], status: 'Ongoing', coverUrl: '' });
  await addToLibrary(key, 'Default');
  await expect(createMihonBackup()).rejects.toThrow(/browser-only/);
});
