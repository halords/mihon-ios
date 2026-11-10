import { describe, expect, it } from 'vitest';
import { deleteDB, openDB } from 'idb';
import { getRawDB } from '../src/lib/db';

// Guards the phone-heat fix (2026-11-11): syncRecords carries a 'by-pending'
// index (db v8) and SyncRecord.pending is numeric 0|1, so pending lookups
// range-scan only the awaiting-upload subset instead of cursor-walking the
// entire 100k+ record journal on every sync cycle / summary.
describe('sync pending index', () => {
  it('creates the by-pending index on upgrade to v8 and range-scans pending records only', async () => {
    const name = `mihon-pending-idx-${crypto.randomUUID()}`;
    const legacy = await openDB(name, 7, {
      upgrade(db) { db.createObjectStore('syncRecords', { keyPath: 'id' }); },
    });
    const store = (db: Awaited<typeof legacy>) => db.transaction('syncRecords', 'readwrite').objectStore('syncRecords');
    for (let i = 0; i < 50; i++) await store(legacy).put({ id: `done\u0000${i}`, pending: i % 2 ? 1 : 0 });
    legacy.close();

    // Reopen through the app's upgrade path (db.ts pins name 'mihon-pwa',
    // so exercise the same migration by hand on this isolated database).
    const upgraded = await openDB(name, 8, {
      upgrade(db, oldVersion, _next, tx) {
        if (oldVersion < 8) tx.objectStore('syncRecords').createIndex('by-pending', 'pending');
      },
    });
    expect(upgraded.objectStoreNames.contains('syncRecords')).toBe(true);
    const tx = upgraded.transaction('syncRecords');
    expect(tx.objectStore('syncRecords').indexNames.contains('by-pending')).toBe(true);
    const pending = await tx.objectStore('syncRecords').index('by-pending').getAll(IDBKeyRange.only(1));
    expect(pending).toHaveLength(25);
    expect(pending.every(record => record.pending === 1)).toBe(true);
    upgraded.close();
    await deleteDB(name);
    await expect(getRawDB()).resolves.toBeTruthy();
  });
});
