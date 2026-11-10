import { beforeEach, expect, it, vi, afterEach } from 'vitest';
import { getRawDB, putManga, addToLibrary, getLibrary, saveReadingProgress } from '../src/lib/db';
import { signInAccount } from '../src/lib/account';
import { setSyncProfileContext } from '../src/lib/syncStorage';
import { syncId } from '../src/lib/syncTypes';

// Regression test for the import-then-login bug (2026-11-11): a library
// imported as a guest used to vanish from view when the user then signed
// in to an account that already had synced data — adoption only ran for
// brand-new accounts, stranding the import in its profile snapshot.
// Sign-in must now pull first, then merge the device library in.
beforeEach(() => setSyncProfileContext('guest'));
afterEach(() => vi.unstubAllGlobals());

const key = 'mangadex::hero';
const chapter = key + '::one';

function mockAccountServer() {
  const pushed: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const action = new URL(url, 'http://localhost').searchParams.get('action') ?? '';
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (action === 'login') return json({ user: { id: 'user-a', email: 'reader@example.com' }, hasSyncedData: true });
    if (action === 'push') { pushed.push('push'); return json({ ok: true }); }
    if (action.startsWith('pull')) return json({ changes: [], cursor: 0, hasMore: false });
    if (action === 'status') return json({ configured: true, user: { id: 'user-a', email: 'reader@example.com' } });
    return json({});
  }));
  return pushed;
}

it('adopts a guest-imported library when signing in to an account with existing synced data', async () => {
  await putManga({ id: 'hero', sourceId: 'mangadex', title: 'Hero', coverUrl: '', genres: [], description: '', status: 'Ongoing' });
  await addToLibrary(key, 'Reading');
  await saveReadingProgress({ key: chapter, mangaKey: key, mangaTitle: 'Hero', coverUrl: '', chapterName: 'Chapter 1', page: 3, updatedAt: 100 }, true);
  expect(await getLibrary()).toHaveLength(1);

  mockAccountServer();
  await signInAccount('reader@example.com', 'correct horse battery staple');

  const db = await getRawDB();
  expect(String((await db.get('syncControl', 'owner'))?.value)).toBe('user-a');
  // The imported title is live in the account profile, not stranded.
  const library = await getLibrary();
  expect(library).toHaveLength(1);
  expect(library[0]?.key).toBe(key);
  // Its sync record is journaled under the account and no longer pending
  // after the post-adoption sync.
  const record = await db.get('syncRecords', syncId('library', key));
  expect(record?.deleted).toBe(false);
  expect(record?.pending).toBe(0);
  // The guest snapshot was consumed by the adoption.
  expect(await db.get('syncProfiles', 'guest')).toBeUndefined();
});
