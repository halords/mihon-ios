import { beforeEach, expect, it, vi, afterEach } from 'vitest';
import { getRawDB } from '../src/lib/db';
import { signInAccount, syncAccount, getAccountState } from '../src/lib/account';
import { setSyncProfileContext } from '../src/lib/syncStorage';
import { syncId, type SyncRecord } from '../src/lib/syncTypes';

beforeEach(() => setSyncProfileContext('guest'));
afterEach(() => vi.unstubAllGlobals());

function mockSync(): SyncRecord[][] {
  const user = { id: 'user-a', email: 'reader@example.com' };
  const pushes: SyncRecord[][] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const action = new URL(url, 'http://localhost').searchParams.get('action') ?? '';
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (action === 'login') return json({ user, hasSyncedData: false });
    if (action === 'push') {
      pushes.push((JSON.parse(String(init?.body)) as { changes: SyncRecord[] }).changes);
      return json({ ok: true });
    }
    if (action === 'pull') return json({ changes: [], cursor: 0, hasMore: false });
    if (action === 'status') return json({ configured: true, user });
    return json({});
  }));
  return pushes;
}

async function seedPending(count: number): Promise<string[]> {
  const db = await getRawDB();
  const tx = db.transaction('syncRecords', 'readwrite');
  const ids: string[] = [];
  // Parallel puts: sequential awaits over thousands of rows blow the
  // 15 s test timeout when the full suite runs in parallel.
  const puts: Promise<unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const key = `mangadex::stream-${i}`;
    const record: SyncRecord = { id: syncId('manga', key), store: 'manga', key,
      data: { key, manga: { id: `stream-${i}`, sourceId: 'mangadex', title: `Stream ${i}`, coverUrl: '', genres: [] } },
      clock: i + 1, deviceId: 'test-device', deleted: false, pending: 1 };
    ids.push(record.id);
    puts.push(tx.store.put(record));
  }
  await Promise.all(puts);
  await tx.done;
  return ids;
}

it('streams a large pending set in capped batches and acks all of them', async () => {
  const pushes = mockSync();
  await signInAccount('reader@example.com', 'correct horse battery staple');
  // Only capture pushes from the explicitly seeded sync below.
  pushes.length = 0;

  // 4,050 records still spans two batches (4000 + 50) and keeps the test
  // comfortably inside the 15 s timeout under full-suite load.
  const ids = await seedPending(4050);
  await syncAccount();

  expect(pushes).toHaveLength(2);
  expect(pushes.map(changes => changes.length)).toEqual([4000, 50]);

  const db = await getRawDB();
  const records = await db.getAll('syncRecords');
  const seededIds = new Set(ids);
  const seeded = records.filter(record => seededIds.has(record.id));
  expect(seeded).toHaveLength(ids.length);
  expect(seeded.every(record => record.pending === 0)).toBe(true);
  expect(records.some(record => record.pending === 1)).toBe(false);
  expect(getAccountState().status).toBe('ready');
  expect(getAccountState().pending).toBe(0);
});

it('quarantine still works across streamed batches', async () => {
  const pushes = mockSync();
  await signInAccount('reader@example.com', 'correct horse battery staple');
  pushes.length = 0;

  const ids = await seedPending(3);
  const key = 'mangadex::big';
  const bigId = syncId('manga', key);
  const record: SyncRecord = { id: bigId, store: 'manga', key,
    data: { key, manga: { id: 'big', sourceId: 'mangadex', title: 'Big', coverUrl: '', genres: [], blob: 'x'.repeat(200 * 1024) } },
    clock: 4, deviceId: 'test-device', deleted: false, pending: 1 };
  const db = await getRawDB();
  await db.put('syncRecords', record);

  await syncAccount();

  const pushedIds = pushes.flatMap(changes => changes.map(change => change.id));
  expect(pushedIds).toEqual(expect.arrayContaining(ids));
  expect(pushedIds).not.toContain(bigId);
  expect((await db.get('syncRecords', bigId))?.pending).toBe(0);
  expect((await db.get('metadata', 'sync:quarantined'))?.value).toContain(bigId);
  expect(getAccountState().status).toBe('ready');
});
