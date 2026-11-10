// SYNC-REVISION-SPEC.md acceptance tests: bulk push/pull over HTTP, the
// 4 MB server body cap, bulk acknowledge with the mid-flight guard, and
// a large pull page applied in one pass.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createClient, type Client } from '@libsql/client';
import { createAccountHandler } from '../server/account';
import { pullChanges } from '../server/accountDatabase';
import { getRawDB } from '../src/lib/db';
import { acknowledgeChanges, activateAccountProfile, applyRemoteChanges } from '../src/lib/account';
import { setSyncProfileContext } from '../src/lib/syncStorage';
import { syncId, type RemoteChange, type SyncChange, type SyncRecord } from '../src/lib/syncTypes';

let client: Client; let server: Server; let origin: string;
beforeEach(async () => {
  setSyncProfileContext('guest');
  client = createClient({ url: 'file::memory:' });
  server = createServer(createAccountHandler(client));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); client.close(); });

async function call(action: string, input?: unknown, cookie = '', id?: string) {
  const response = await fetch(origin + '/api/account?action=' + action, { method: input === undefined ? 'GET' : 'POST', headers: {
    'X-Mihon-Request': '1', 'X-Mihon-Sync-Version': '2', 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, ...(id ? { 'X-Mihon-Account': id } : {}),
  }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
const chapterState = (i: number, clock = 100): SyncChange => {
  const key = 'mangadex::hero::ch-' + i;
  return { id: syncId('chapterState', key), store: 'chapterState', key, clock, deviceId: 'device-a', deleted: false,
    data: { key, mangaKey: 'mangadex::hero', read: true, lastPage: i % 20, lastReadAt: 1000 + i, pageOffset: 0 } };
};

it('accepts a 4,000-change push in one request and pulls every record back exactly once', async () => {
  const a = await call('register', { email: 'bulk@example.com', password: 'correct horse battery staple' });
  const id = a.data.user.id;
  const changes = Array.from({ length: 4000 }, (_, i) => chapterState(i));
  const started = Date.now();
  const pushed = await call('push', { changes }, a.cookie, id);
  expect(pushed.status).toBe(200); expect(pushed.data.saved).toBe(4000);
  const seen = new Set<string>(); let cursor = 0;
  for (;;) {
    const page = await pullChanges(client, id, cursor);
    for (const change of page.changes) { expect(seen.has(change.id)).toBe(false); seen.add(change.id); }
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  expect(seen.size).toBe(4000);
  console.info(`[sync-revision] 4,000-change push + pull walk: ${Date.now() - started}ms (local in-memory libSQL)`);
}, 60000);

it('enforces the 4 MB body cap: ~3.8 MB passes, over 4 MB is a 413', async () => {
  const a = await call('register', { email: 'caps@example.com', password: 'correct horse battery staple' });
  const id = a.data.user.id;
  const big = (i: number): SyncChange => {
    const key = 'mangadex::big-' + i;
    return { id: syncId('manga', key), store: 'manga', key, clock: i, deviceId: 'device-a', deleted: false,
      data: { key, manga: { id: 'big-' + i, sourceId: 'mangadex', title: 'Big', coverUrl: '', genres: [], description: 'x'.repeat(100000) } } };
  };
  const fits = await call('push', { changes: Array.from({ length: 38 }, (_, i) => big(i)) }, a.cookie, id);
  expect(fits.status).toBe(200); expect(fits.data.saved).toBe(38);
  const tooBig = await call('push', { changes: Array.from({ length: 42 }, (_, i) => big(100 + i)) }, a.cookie, id);
  expect(tooBig.status).toBe(413);
}, 60000);

it('acknowledges a large batch in one call and keeps mid-flight edits pending', async () => {
  await activateAccountProfile('user-a');
  const db = await getRawDB();
  const sent: SyncRecord[] = Array.from({ length: 1500 }, (_, i) => {
    const key = 'mangadex::hero::ch-' + i;
    return { id: syncId('chapterState', key), store: 'chapterState', key, clock: 500, deviceId: 'device-a', deleted: false,
      data: { key, mangaKey: 'mangadex::hero', read: true, lastPage: 1, lastReadAt: 1, pageOffset: 0 }, pending: true };
  });
  const tx = db.transaction('syncRecords', 'readwrite'); const store = tx.objectStore('syncRecords');
  for (const record of sent) void store.put(record);
  await tx.done;
  // One record is edited while the batch is "in flight": its clock moves.
  const edited = sent[777]!;
  await db.put('syncRecords', { ...edited, clock: edited.clock + 1, data: { ...(edited.data as object), lastPage: 9 } });
  await acknowledgeChanges(sent, 'user-a');
  const all = await db.getAll('syncRecords');
  expect(all.filter(record => record.pending)).toEqual([expect.objectContaining({ id: edited.id, clock: edited.clock + 1 })]);
}, 60000);

it('applies a 2,000-change pull page with downloads preserved and removals marked', async () => {
  await activateAccountProfile('user-a');
  const db = await getRawDB();
  const downloadedKey = 'mangadex::hero::ch-0';
  await db.put('chapterState', { key: downloadedKey, mangaKey: 'mangadex::hero', read: false, lastPage: 0, lastReadAt: 0, pageOffset: 0, downloaded: true });
  const changes: RemoteChange[] = [];
  for (let i = 0; i < 1000; i++) {
    const key = 'mangadex::hero::ch-' + i;
    changes.push({ id: syncId('chapterState', key), store: 'chapterState', key, clock: 900, deviceId: 'other-device', revision: i + 1, deleted: false,
      data: { key, mangaKey: 'mangadex::hero', read: true, lastPage: 7, lastReadAt: 5000, pageOffset: 0.5 } });
  }
  for (let i = 0; i < 999; i++) {
    const key = 'mangadex::hero::ch-' + i;
    changes.push({ id: syncId('chapterMeta', key), store: 'chapterMeta', key, clock: 900, deviceId: 'other-device', revision: 1001 + i, deleted: false,
      data: { key, mangaKey: 'mangadex::hero', chapter: { id: 'ch-' + i, name: 'Chapter ' + (i + 1), number: i + 1 } } });
  }
  changes.push({ id: syncId('library', 'mangadex::gone'), store: 'library', key: 'mangadex::gone', clock: 900, deviceId: 'other-device', revision: 2000, deleted: true, data: null });
  await applyRemoteChanges(changes, 2000, 'user-a');
  expect(await db.count('chapterState')).toBe(1000);
  expect(await db.count('chapterMeta')).toBe(999);
  expect(await db.get('chapterState', downloadedKey)).toMatchObject({ read: true, lastPage: 7, downloaded: true });
  // The removal marker is written inside the apply transaction; the
  // post-apply purge may already have consumed its pending flag.
  expect(await db.get('metadata', 'downloads:removed:mangadex::gone')).toBeDefined();
  expect((await db.get('syncControl', 'cursor'))?.value).toBe(2000);
  expect((await db.get('syncControl', 'clock'))?.value).toBe(900);
  expect((await db.getAll('syncRecords')).filter(record => record.pending)).toHaveLength(0);
}, 60000);
