import { expect, it } from 'vitest';
import { exportData, importData, getDB, getChapterState, getArchives, patchChapterState, validateBackupData, saveReadingProgress, putChapterMetas, getChapterMetas } from '../src/lib/db';
import { inspectTachibkFile, restoreTachibk } from '../src/backup/tachibk';
import { schemaFile, EXACT_SOURCE, READ_AT } from './fixtures/mihon';
const key = EXACT_SOURCE + '::/series/hero';
it('retains optional chapter metadata when a source refresh omits it', async () => {
  const chapter = { id: '/chapter/1', mangaId: '/series/hero', name: 'Chapter 1', number: 1, dateUpload: 123, scanlator: 'Original group', memo: 'Retained notes' };
  await putChapterMetas(String(EXACT_SOURCE), '/series/hero', [chapter]);
  await putChapterMetas(String(EXACT_SOURCE), '/series/hero', [{ ...chapter, name: 'Updated name', scanlator: undefined, memo: undefined }]);
  expect((await getChapterMetas(key))[0]?.chapter).toMatchObject({ name: 'Updated name', scanlator: 'Original group', memo: 'Retained notes' });
});
it('round-trips original archives and metadata in JSON v2', async () => {
  await restoreTachibk(await inspectTachibkFile(schemaFile()));
  const json = JSON.parse(JSON.stringify(await exportData()));
  const db = await getDB();
  for (const name of db.objectStoreNames) await db.clear(name);
  await importData(json);
  expect(await db.count('library')).toBe(2);
  expect((await getArchives())[0]!.bytes.size).toBe(schemaFile().size);
  expect((await db.get('manga', key))?.mihon?.notes).toBe('Saved notes');
});
it('does not resurrect stale downloaded flags without the actual pages', async () => {
  await restoreTachibk(await inspectTachibkFile(schemaFile()));
  const data = await exportData();
  data.chapterState[0]!.downloaded = true;
  data.downloads = [{ key: data.chapterState[0]!.key, mangaKey: data.chapterState[0]!.mangaKey, pageCount: 2, downloadedAt: READ_AT }];
  await importData(data);
  expect((await getChapterState(data.chapterState[0]!.key))?.downloaded).toBe(false);
  expect(await (await getDB()).count('downloads')).toBe(0);
});
it('preserves newer local position and explicit unread state when merging JSON', async () => {
  await restoreTachibk(await inspectTachibkFile(schemaFile()));
  const data = await exportData();
  await patchChapterState(key + '::/chapter/1', key, { read: false, lastPage: 0, lastReadAt: READ_AT + 10000 });
  await patchChapterState(key + '::/chapter/2', key, { lastPage: 19, pageOffset: .4, lastReadAt: READ_AT + 10000 });
  await importData(data);
  expect(await getChapterState(key + '::/chapter/1')).toMatchObject({ read: false, lastPage: 0 });
  expect(await getChapterState(key + '::/chapter/2')).toMatchObject({ lastPage: 19, pageOffset: .4 });
});
it('rejects malformed JSON and archives without partially mutating the library', async () => {
  await restoreTachibk(await inspectTachibkFile(schemaFile()));
  const data = await exportData();
  const before = await (await getDB()).count('manga');
  data.manga.push({ ...data.manga[0]!, key: 'wrong-key' });
  await expect(importData(data)).rejects.toThrow(/Invalid manga/);
  expect(await (await getDB()).count('manga')).toBe(before);
  expect(() => validateBackupData({ version: 2 })).toThrow(/records/);
  const bad = await exportData();
  bad.archives![0]!.base64 = '%%%';
  await expect(importData(bad)).rejects.toThrow();
  expect(await (await getDB()).count('manga')).toBe(before);
});
it('saves chapter progress and reading history atomically while retaining bookmarks', async () => {
  const chapterKey = key + '::/chapter/2';
  await patchChapterState(chapterKey, key, { bookmark: true });
  await saveReadingProgress({ key: chapterKey, mangaKey: key, mangaTitle: 'Hero', chapterName: 'Chapter 2', coverUrl: '', updatedAt: READ_AT, page: 4, readDuration: 2000 }, false, .6);
  await saveReadingProgress({ key: chapterKey, mangaKey: key, mangaTitle: 'Hero', chapterName: 'Chapter 2', coverUrl: '', updatedAt: READ_AT + 1000, page: 5, readDuration: 1000 }, true, 0);
  expect(await getChapterState(chapterKey)).toMatchObject({ lastPage: 5, read: true, bookmark: true });
  expect(await (await getDB()).get('history', chapterKey)).toMatchObject({ page: 5, readDuration: 3000 });
});
