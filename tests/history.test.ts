import { expect, it, vi } from 'vitest';
import { getRawDB, type HistoryRecord } from '../src/lib/db';
import { HISTORY_PAGE_SIZE, loadHistoryPage } from '../src/lib/history';

async function seed(count: number, sameDate = false) {
  const db = await getRawDB();
  const tx = db.transaction('history', 'readwrite');
  for (let index = 0; index < count; index++) {
    const record: HistoryRecord = { key: 'source::hero::' + String(index).padStart(5, '0'), mangaKey: 'source::hero',
      mangaTitle: index === 0 ? 'An older unique title' : 'Hero', chapterName: 'Chapter ' + index, coverUrl: '', page: index,
      updatedAt: sameDate ? 100 : index + 1 };
    await tx.store.put(record);
  }
  await tx.done; return db;
}
it('reads only a bounded newest-first page without loading history or chapter stores in full', async () => {
  const db = await seed(2000);
  const scan = vi.spyOn(db, 'getAll');
  const result = await loadHistoryPage();
  expect(result.records).toHaveLength(HISTORY_PAGE_SIZE);
  expect(result.records[0]?.page).toBe(1999);
  expect(result.total).toBe(2000);
  expect(scan).not.toHaveBeenCalled();
});
it('paginates identical timestamps without missing or duplicating entries, even after removal', async () => {
  const db = await seed(85, true);
  const first = await loadHistoryPage();
  await db.delete('history', first.records.at(-1)!.key);
  const second = await loadHistoryPage({ before: first.next! });
  const third = await loadHistoryPage({ before: second.next! });
  expect([...first.records, ...second.records, ...third.records].map(record => record.page)).toEqual(Array.from({ length: 85 }, (_, index) => 84 - index));
  expect(third.next).toBeNull();
});
it('searches older history beyond the first page and handles a page with one record', async () => {
  await seed(620);
  const result = await loadHistoryPage({ query: ' OLDER UNIQUE ' });
  expect(result.records.map(record => record.page)).toEqual([0]);
  expect(result.next).toBeNull();
  const first = await loadHistoryPage({ limit: 1 });
  expect(first.records[0]?.page).toBe(619);
  expect((await loadHistoryPage({ before: first.next!, limit: 1 })).records[0]?.page).toBe(618);
});
it('checks resume availability only for the page and supports cancelled searches', async () => {
  const db = await seed(80);
  const key = 'source::hero::00079';
  await db.put('chapterMeta', { key, mangaKey: 'source::hero', chapter: { id: '00079', mangaId: 'hero', name: 'Chapter 79', number: 79, dateUpload: 1 } });
  await db.put('downloads', { key, mangaKey: 'source::hero', pageCount: 1, downloadedAt: 1 });
  const result = await loadHistoryPage();
  expect([...result.chapters]).toEqual([key]); expect([...result.downloads]).toEqual([key]);
  const controller = new AbortController(); controller.abort();
  await expect(loadHistoryPage({ query: 'absent', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
});
