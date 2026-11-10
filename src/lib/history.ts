import { getRawDB, type HistoryRecord } from './db';

export type HistoryCursor = [number, string];
export const HISTORY_PAGE_SIZE = 40;
export interface HistoryPageData {
  records: HistoryRecord[];
  next: HistoryCursor | null;
  chapters: Set<string>;
  downloads: Set<string>;
  total: number;
}

// Read newest-first from the index, rather than cloning and sorting the whole
// history. Short search transactions let navigation and sync writes continue.
export async function loadHistoryPage({ before, query = '', signal, limit = HISTORY_PAGE_SIZE }: {
  before?: HistoryCursor; query?: string; signal?: AbortSignal; limit?: number;
} = {}): Promise<HistoryPageData> {
  signal?.throwIfAborted();
  const db = await getRawDB();
  signal?.throwIfAborted();
  const records: HistoryRecord[] = [];
  const needle = query.trim().toLowerCase();
  const pageSize = Math.max(1, Math.min(HISTORY_PAGE_SIZE, Math.floor(limit)));
  let boundary = before;
  let more = false;
  while (records.length < pageSize) {
    signal?.throwIfAborted();
    const tx = db.transaction('history');
    const index = tx.store.index('by-updated');
    const newest = await index.openKeyCursor(boundary ? IDBKeyRange.upperBound(boundary, true) : undefined, 'prev');
    if (!newest) { await tx.done; more = false; break; }
    const top = newest.key;
    const batchSize = needle ? 200 : pageSize;
    const oldest = batchSize > 1 ? await newest.advance(batchSize - 1) : newest;
    const range = oldest ? IDBKeyRange.bound(oldest.key, top) : IDBKeyRange.upperBound(top);
    const batch = (await index.getAll(range, batchSize)).reverse();
    const following = oldest ? await oldest.continue() : null;
    await tx.done;
    more = !!following;
    for (const [position, record] of batch.entries()) {
      signal?.throwIfAborted();
      boundary = [record.updatedAt, record.key];
      if (!needle || (record.mangaTitle + ' ' + record.chapterName).toLowerCase().includes(needle)) records.push(record);
      if (records.length >= pageSize) { more ||= position < batch.length - 1; break; }
    }
    if (!more || records.length >= pageSize) break;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  const tx = db.transaction(['history', 'chapterMeta', 'downloads']);
  const [total, availability] = await Promise.all([
    tx.objectStore('history').count(),
    Promise.all(records.map(async record => ({ key: record.key,
      chapter: await tx.objectStore('chapterMeta').getKey(record.key),
      download: await tx.objectStore('downloads').getKey(record.key) }))),
  ]);
  await tx.done;
  signal?.throwIfAborted();
  return { records, next: more ? boundary! : null, total,
    chapters: new Set(availability.filter(item => item.chapter !== undefined).map(item => item.key)),
    downloads: new Set(availability.filter(item => item.download !== undefined).map(item => item.key)) };
}
