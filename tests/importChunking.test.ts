import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { importData, getDB, getManga, getLibraryEntry, getChapterState, addToLibrary, patchChapterState, type BackupData } from '../src/lib/db';
import { mangaKey } from '../src/sources/Source';

const T0 = 1700000000000;

function titleData(sourceId: string, mangaId: string, title: string) {
  const key = mangaKey(sourceId, mangaId);
  const chapter = (id: string, n: number) => ({ id, mangaId, name: `Chapter ${n}`, number: n, dateUpload: 1000 });
  return {
    key,
    manga: { key, manga: { id: mangaId, sourceId, title, coverUrl: '', genres: [], description: '', status: 'Ongoing' as const }, updatedAt: T0 },
    chapterMeta: [1, 2].map(n => ({ key: `${key}::/chapter/${n}`, mangaKey: key, chapter: chapter(`/chapter/${n}`, n) })),
    chapterState: [1, 2].map(n => ({ key: `${key}::/chapter/${n}`, mangaKey: key, read: false, lastPage: 0, downloaded: false })),
    library: { key, category: 'Default', categories: ['Default'], addedAt: T0 },
    history: [{ key: `${key}::/chapter/1`, mangaKey: key, mangaTitle: title, coverUrl: '', chapterName: 'Chapter 1', page: 2, updatedAt: T0 }],
  };
}

function backupData(...titles: ReturnType<typeof titleData>[]): BackupData {
  return {
    version: 2, exportedAt: T0,
    manga: titles.map(t => t.manga),
    chapterMeta: titles.flatMap(t => t.chapterMeta),
    chapterState: titles.flatMap(t => t.chapterState),
    library: titles.map(t => t.library),
    history: titles.flatMap(t => t.history),
    downloads: [],
  };
}

describe('JSON import chunking', () => {
  it('imports multiple titles with correct merges and is idempotent on re-import', async () => {
    const a = titleData('chunk-a-source', '/manga/a', 'Title A');
    const b = titleData('chunk-b-source', '/manga/b', 'Title B');
    await patchChapterState(a.key + '::/chapter/1', a.key, { read: true, lastPage: 5, lastReadAt: T0 + 10000 });
    await addToLibrary(a.key, ['Personal']);
    const localLibrary = await getLibraryEntry(a.key);
    const data = backupData(a, b);
    const db = await getDB();

    for (let run = 0; run < 2; run++) {
      await importData(data);
      for (const title of [a, b]) {
        expect(await getManga(title.key)).toBeDefined();
        for (const r of title.chapterMeta) {
          expect(await db.get('chapterMeta', r.key)).toEqual(r);
        }
        for (const r of title.history) {
          expect(await db.get('history', r.key)).toEqual(r);
        }
      }
      expect(await getChapterState(a.key + '::/chapter/1')).toMatchObject({
        read: true, lastPage: 5, lastReadAt: T0 + 10000,
      });
      expect(await getChapterState(a.key + '::/chapter/2')).toMatchObject({
        read: false, lastPage: 0,
      });
      const importedLibrary = await getLibraryEntry(a.key);
      expect(importedLibrary?.categories).toEqual(['Default', 'Personal']);
      expect(importedLibrary?.addedAt).toBe(localLibrary?.addedAt);
      expect(await getLibraryEntry(b.key)).toMatchObject(b.library);
      for (const r of b.chapterState) {
        expect(await getChapterState(r.key)).toMatchObject(r);
      }
    }
  });

  it('keeps completed titles when the import fails midway', async () => {
    const c = titleData('chunk-c-source', '/manga/c', 'Title C');
    const d = titleData('chunk-d-source', '/manga/d', 'Title D');
    await expect(importData(backupData(c, d), false, {
      onProgress() {
        throw new Error('Simulated storage failure');
      },
    })).rejects.toThrow('Simulated storage failure');

    expect(await getManga(c.key)).toBeDefined();
    expect(await getLibraryEntry(c.key)).toBeDefined();
    expect(await getManga(d.key)).toBeUndefined();

    await importData(backupData(c, d));
    expect(await getManga(c.key)).toBeDefined();
    expect(await getLibraryEntry(c.key)).toBeDefined();
    expect(await getManga(d.key)).toBeDefined();
    expect(await getLibraryEntry(d.key)).toBeDefined();
  });

  it('rejects an invalid plugin before writing anything', async () => {
    const e = titleData('chunk-e-source', '/manga/e', 'Title E');
    await expect(importData({
      ...backupData(e),
      plugins: [{ id: 'bad-plugin' }] as never,
    }, true)).rejects.toThrow('Invalid web extension');

    expect(await getManga(e.key)).toBeUndefined();
  });
});
