import { beforeEach, expect, it, vi, afterEach } from 'vitest';
import { getDB, getRawDB, putManga, addToLibrary } from '../src/lib/db';
import { signInAccount, getAccountState } from '../src/lib/account';
import { setSyncProfileContext } from '../src/lib/syncStorage';
import { syncId, type SyncRecord } from '../src/lib/syncTypes';

// Regression test for the sync-wedge bug (2026-11-13): one local record
// failing validChange used to throw inside cycle()'s push loop, skipping
// the pull loop and re-throwing on every open with no recovery. The
// record is now quarantined (pending 0, id stashed in metadata) and the
// batch — and the pull — continue.
beforeEach(() => setSyncProfileContext('guest'));
afterEach(() => vi.unstubAllGlobals());

it('quarantines an oversized adopted record without blocking valid pushes or pulls', async () => {
  const heroKey = 'mangadex::hero';
  const bigKey = 'mangadex::big';

  await putManga({ id: 'hero', sourceId: 'mangadex', title: 'Hero', coverUrl: '', genres: [], description: '', status: 'Ongoing' });
  await addToLibrary(heroKey, 'Reading');

  await putManga({ id: 'big', sourceId: 'mangadex', title: 'Big', coverUrl: '', genres: [], description: '', status: 'Ongoing' });
  const guestDB = await getDB();
  const row = await guestDB.get('manga', bigKey);
  if (!row) throw new Error('Missing manga fixture');
  // Adoption imports store rows (not sync records), so the invalidity
  // must live in the manga data: a mihon payload past validChange's
  // 128 KB canonical(data) cap, the plausible real-world trigger.
  await guestDB.put('manga', { ...row, mihon: { blob: 'x'.repeat(200 * 1024) } });
  await addToLibrary(bigKey, 'Reading');

  const user = { id: 'user-a', email: 'reader@example.com' };
  const pushes: SyncRecord[][] = [];
  let pulls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const action = new URL(url, 'http://localhost').searchParams.get('action') ?? '';
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (action === 'login') return json({ user, hasSyncedData: true });
    if (action === 'push') {
      pushes.push((JSON.parse(String(init?.body)) as { changes: SyncRecord[] }).changes);
      return json({ ok: true });
    }
    if (action === 'pull') { pulls++; return json({ changes: [], cursor: 0, hasMore: false }); }
    if (action === 'status') return json({ configured: true, user });
    return json({});
  }));

  await signInAccount('reader@example.com', 'correct horse battery staple');

  const heroId = syncId('manga', heroKey);
  const bigId = syncId('manga', bigKey);
  const pushedIds = pushes.flatMap(changes => changes.map(record => record.id));
  expect(pushedIds).toContain(heroId);
  expect(pushedIds).not.toContain(bigId);
  expect(pulls).toBeGreaterThan(0);

  const db = await getRawDB();
  expect((await db.get('syncRecords', bigId))?.pending).toBe(0);
  expect((await db.get('metadata', 'sync:quarantined'))?.value).toContain(bigId);
  expect(getAccountState().quarantined).toBe(1);
  expect(getAccountState().status).toBe('ready');
});
