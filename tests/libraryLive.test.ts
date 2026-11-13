import { expect, it, vi } from 'vitest';
import { registerSource } from '../src/sources';
import { chapterKey, mangaKey } from '../src/sources/Source';
import { addToLibrary, patchChapterState, putChapterMetas, putDownload, putManga, saveReadingProgress } from '../src/lib/db';
import { applyLibraryLiveUpdate, getLibrarySnapshot, loadLibrary, loadLibraryItem, setLibrarySnapshot } from '../src/lib/libraryData';
import { emitLibraryLive } from '../src/lib/libraryLive';
import { activateAccountProfile } from '../src/lib/account';
import { compareLibraryItems } from '../src/lib/librarySort';
import { loadSettings } from '../src/lib/settings';
import { testSource } from './fixtures/source';

const T0 = 1700000000000;
const T1 = 1700000001000;
const T2 = 1700000002000;
const T3 = 1700000003000;
const T9 = 1700000009000;

async function seedTitle(sourceId: string, mangaId: string, title: string, chapterCount: number, addedAt?: number) {
  const fixture = testSource(sourceId, chapterCount);
  const manga = { ...fixture.manga, id: mangaId, title };
  const chapters = fixture.chapters.map(c => ({ ...c, mangaId }));
  fixture.source.getChapterList = vi.fn(async () => chapters);
  registerSource(fixture.source);
  await putManga(manga);
  await putChapterMetas(sourceId, mangaId, chapters);
  await addToLibrary(mangaKey(sourceId, mangaId), ['Default'], addedAt);
  const key = mangaKey(sourceId, mangaId);
  return { manga, chapters, key, chapterKeys: chapters.map(c => chapterKey(sourceId, mangaId, c.id)) };
}

let a: Awaited<ReturnType<typeof seedTitle>>;
let b: Awaited<ReturnType<typeof seedTitle>>;

// Seeded per test, not in beforeAll: writes made in beforeAll are not
// visible to the tests in this setup (no other test file uses beforeAll
// with the database). Re-seeding is idempotent — puts overwrite, and
// addToLibrary keeps the first addedAt.
async function seedAll(): Promise<void> {
  a = await seedTitle('live-a-source', '/hero-a', 'Alpha', 3);
  b = await seedTitle('live-b-source', '/hero-b', 'Beta', 2);
  // Title A: chapter 1 downloaded, reading history on chapters 1 (newer)
  // and 2 (older) so the resume card can advance when chapter 1 finishes.
  await putDownload({ key: a.chapterKeys[0]!, mangaKey: a.key, pageCount: 10, downloadedAt: T0 });
  await patchChapterState(a.chapterKeys[0]!, a.key, { downloaded: true });
  await saveReadingProgress({ key: a.chapterKeys[1]!, mangaKey: a.key, mangaTitle: 'Alpha', coverUrl: '', chapterName: 'Chapter 2', page: 3, updatedAt: T0 }, false);
  await saveReadingProgress({ key: a.chapterKeys[0]!, mangaKey: a.key, mangaTitle: 'Alpha', coverUrl: '', chapterName: 'Chapter 1', page: 5, updatedAt: T1 }, false);
}

function historyFor(title: typeof a, index: number, page: number, updatedAt: number) {
  return { key: title.chapterKeys[index]!, mangaKey: title.key, mangaTitle: title.manga.title, coverUrl: '', chapterName: 'Chapter ' + (index + 1), page, updatedAt };
}

it('finishing a chapter updates its counts and advances the resume card', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  const item = snapshot.items.find(i => i.entry.key === a.key)!;
  expect(item.unread).toBe(3);
  expect(item.downloaded).toBe(1);
  expect(snapshot.resume?.key).toBe(a.chapterKeys[0]);

  const next = await applyLibraryLiveUpdate(snapshot, { type: 'chapter-progress', mangaKey: a.key,
    chapterKey: a.chapterKeys[0]!, history: historyFor(a, 0, 10, T2), read: true, downloadedDeleted: true });
  expect(next).not.toBe(snapshot);
  const updated = next.items.find(i => i.entry.key === a.key)!;
  expect(updated.unread).toBe(2);
  expect(updated.downloaded).toBe(0);
  expect(updated.sort.unread).toBe(2);
  expect(updated.lastRead).toBe(T2);
  expect(updated.sort.read).toBe(T2);
  expect(next.state.get(a.chapterKeys[0])).toMatchObject({ read: true, downloaded: false });
  expect(next.downloaded.has(a.chapterKeys[0]!)).toBe(false);
  // Resume advances to the next unread history entry (chapter 2).
  expect(next.resume?.key).toBe(a.chapterKeys[1]);

  // Re-applying the same progress is harmless (the reader emits repeatedly).
  const again = await applyLibraryLiveUpdate(next, { type: 'chapter-progress', mangaKey: a.key,
    chapterKey: a.chapterKeys[0]!, history: historyFor(a, 0, 10, T2), read: true, downloadedDeleted: true });
  expect(again.items.find(i => i.entry.key === a.key)).toMatchObject({ unread: 2, downloaded: 0 });
});

it('unfinished progress bumps last-read without changing the counts', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  const next = await applyLibraryLiveUpdate(snapshot, { type: 'chapter-progress', mangaKey: b.key,
    chapterKey: b.chapterKeys[0]!, history: historyFor(b, 0, 2, T3), read: false, downloadedDeleted: false });
  const updated = next.items.find(i => i.entry.key === b.key)!;
  expect(updated.unread).toBe(2);
  expect(updated.downloaded).toBe(0);
  expect(updated.lastRead).toBe(T3);
  expect(next.resume?.key).toBe(b.chapterKeys[0]);
});

it('opening and loading a chapter moves its title first under the Last-read sort', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  const settings = loadSettings();
  expect(settings.librarySort).toBe('read');
  const before = [...snapshot.items].sort((x, y) => compareLibraryItems(x.sort, y.sort, settings));
  expect(before[0]!.entry.key).toBe(a.key);

  // The reader saves progress the moment a chapter loads (flush on load),
  // so an unread chapter-progress event IS the "opened and loaded" signal.
  // Merely opening the details page emits nothing (no emit in nav.tsx) —
  // the title must not move until a chapter actually loads.
  const next = await applyLibraryLiveUpdate(snapshot, { type: 'chapter-progress', mangaKey: b.key,
    chapterKey: b.chapterKeys[0]!, history: historyFor(b, 0, 0, T9), read: false, downloadedDeleted: false });
  const after = [...next.items].sort((x, y) => compareLibraryItems(x.sort, y.sort, settings));
  expect(after[0]!.entry.key).toBe(b.key);
  expect(next.items.find(i => i.entry.key === b.key)!.lastRead).toBe(T9);

  // Unknown titles are a no-op (same reference, no re-render).
  expect(await applyLibraryLiveUpdate(next, { type: 'chapter-progress', mangaKey: 'nope::/none',
    chapterKey: 'nope::/none::/ch', history: { ...historyFor(b, 0, 0, T9), mangaKey: 'nope::/none', key: 'nope::/none::/ch' },
    read: false, downloadedDeleted: false })).toBe(next);
  // Stale progress never drags the title back down.
  const stale = await applyLibraryLiveUpdate(next, { type: 'chapter-progress', mangaKey: b.key,
    chapterKey: b.chapterKeys[0]!, history: historyFor(b, 0, 0, T1), read: false, downloadedDeleted: false });
  expect(stale.items.find(i => i.entry.key === b.key)!.lastRead).toBe(T9);
});

it('adding a title inserts it first without a full reload', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  expect(snapshot.items.some(i => i.entry.key === 'live-c-source::/hero-c')).toBe(false);
  const c = await seedTitle('live-c-source', '/hero-c', 'Gamma', 2, T9);

  const next = await applyLibraryLiveUpdate(snapshot, { type: 'library-added', mangaKey: c.key });
  const added = next.items.find(i => i.entry.key === c.key)!;
  expect(added.unread).toBe(2);
  expect(added.lastRead).toBe(0);
  expect(added.sort.read).toBe(T9);
  const settings = loadSettings();
  const sorted = [...next.items].sort((x, y) => compareLibraryItems(x.sort, y.sort, settings));
  expect(sorted[0]!.entry.key).toBe(c.key);
  // Second add is a no-op.
  expect(await applyLibraryLiveUpdate(next, { type: 'library-added', mangaKey: c.key })).toBe(next);
  // The targeted loader agrees with the snapshot shape.
  const loaded = await loadLibraryItem(c.key);
  expect(loaded?.item.unread).toBe(2);
  expect(await loadLibraryItem('nope::/none')).toBeNull();
});

it('library-invalidated reloads the snapshot with restored titles', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  setLibrarySnapshot(snapshot);

  // A fresh title (not Gamma — the test above already seeds it): the
  // reload must pick up a title that was NOT in the snapshot.
  const d = await seedTitle('live-d-source', '/hero-d', 'Delta', 2, T9);
  emitLibraryLive({ type: 'library-invalidated' });

  const deadline = Date.now() + 2000;
  let next = getLibrarySnapshot();
  while (!next?.items.some(i => i.entry.key === d.key) && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    next = getLibrarySnapshot();
  }

  expect(next).not.toBe(snapshot);
  expect(next?.items.find(i => i.entry.key === d.key)?.unread).toBe(2);
  expect(next?.items.some(i => i.entry.key === a.key)).toBe(true);
  expect(next?.items.some(i => i.entry.key === b.key)).toBe(true);
});

it('account switch replaces the snapshot with the new profile’s library', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  setLibrarySnapshot(snapshot);
  expect(snapshot.items.some(i => i.entry.key === a.key)).toBe(true);

  // Switching to a fresh account profile empties the live library; the
  // snapshot must follow (pre-fix it kept showing the previous profile's
  // titles, and tapping one errored).
  await activateAccountProfile('user-a');
  const deadline = Date.now() + 2000;
  let next = getLibrarySnapshot();
  while (next === snapshot && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    next = getLibrarySnapshot();
  }
  expect(next).not.toBe(snapshot);
  expect(next?.items).toHaveLength(0);

  // Switching back restores the guest library in the snapshot too.
  await activateAccountProfile('guest');
  const backBy = Date.now() + 2000;
  let back = getLibrarySnapshot();
  while (!back?.items.some(i => i.entry.key === a.key) && Date.now() < backBy) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    back = getLibrarySnapshot();
  }
  expect(back?.items.some(i => i.entry.key === a.key)).toBe(true);
  expect(back?.items.some(i => i.entry.key === b.key)).toBe(true);
});

it('removing a title drops it and recomputes the resume card', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  expect(snapshot.resume?.mangaKey).toBe(a.key);
  const next = await applyLibraryLiveUpdate(snapshot, { type: 'library-removed', mangaKey: a.key });
  expect(next.items.some(i => i.entry.key === a.key)).toBe(false);
  expect(next.resume?.mangaKey).not.toBe(a.key);
  expect(await applyLibraryLiveUpdate(next, { type: 'library-removed', mangaKey: a.key })).toBe(next);
});

it('emitted events patch the module snapshot with no reload', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  setLibrarySnapshot(snapshot);
  emitLibraryLive({ type: 'chapter-progress', mangaKey: a.key,
    chapterKey: a.chapterKeys[0]!, history: historyFor(a, 0, 10, T2), read: true, downloadedDeleted: true });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const patched = getLibrarySnapshot()!;
  expect(patched).not.toBe(snapshot);
  expect(patched.items.find(i => i.entry.key === a.key)).toMatchObject({ unread: 2, downloaded: 0 });
});

it('counts-changed refreshes one title\'s counts without moving it', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  const item = snapshot.items.find(i => i.entry.key === a.key)!;
  const other = snapshot.items.find(i => i.entry.key === b.key)!;
  expect(item.unread).toBe(3);
  expect(item.downloaded).toBe(1);
  expect(item.sort.read).toBe(T1);
  expect(item.entry.addedAt).toBeGreaterThan(T1);
  expect(other.sort.read).toBe(0);
  const settings = loadSettings();
  expect(settings.librarySort).toBe('read');
  const before = [...snapshot.items].sort((x, y) => compareLibraryItems(x.sort, y.sort, settings));
  expect(before[0]!.entry.key).toBe(a.key);

  await patchChapterState(a.chapterKeys[1]!, a.key, { read: true });
  await putDownload({ key: a.chapterKeys[2]!, mangaKey: a.key, pageCount: 10, downloadedAt: T0 });
  await patchChapterState(a.chapterKeys[2]!, a.key, { downloaded: true });

  const next = await applyLibraryLiveUpdate(snapshot, { type: 'counts-changed', mangaKey: a.key });
  expect(next).not.toBe(snapshot);
  const updated = next.items.find(i => i.entry.key === a.key)!;
  expect(updated.unread).toBe(2);
  expect(updated.downloaded).toBe(2);
  expect(updated.sort.unread).toBe(2);
  expect(updated.lastRead).toBe(T1);
  // Do not inherit the targeted loader's newly-added sort boost.
  expect(updated.sort.read).toBe(T1);
  expect(next.items.find(i => i.entry.key === b.key)).toBe(other);
  expect(next.history).toBe(snapshot.history);
  expect(next.state.get(a.chapterKeys[1]!)).toMatchObject({ read: true });
  expect(next.downloaded.has(a.chapterKeys[2]!)).toBe(true);
  const after = [...next.items].sort((x, y) => compareLibraryItems(x.sort, y.sort, settings));
  expect(after[0]!.entry.key).toBe(a.key);

  const again = await applyLibraryLiveUpdate(next, { type: 'counts-changed', mangaKey: a.key });
  expect(again.items.find(i => i.entry.key === a.key)).toMatchObject({
    unread: 2, downloaded: 2, lastRead: T1, sort: { unread: 2, read: T1 },
  });
  expect(again.items.find(i => i.entry.key === b.key)).toBe(other);
});

it('counts-changed updates the bookmarked flag', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  expect(snapshot.items.find(i => i.entry.key === a.key)!.bookmarked).toBe(false);

  await patchChapterState(a.chapterKeys[0]!, a.key, { bookmark: true });
  const next = await applyLibraryLiveUpdate(snapshot, { type: 'counts-changed', mangaKey: a.key });
  expect(next.items.find(i => i.entry.key === a.key)!.bookmarked).toBe(true);

  await patchChapterState(a.chapterKeys[0]!, a.key, { bookmark: false });
  const cleared = await applyLibraryLiveUpdate(next, { type: 'counts-changed', mangaKey: a.key });
  expect(cleared.items.find(i => i.entry.key === a.key)!.bookmarked).toBe(false);
});

it('counts-changed for an unknown title is a no-op', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  expect(await applyLibraryLiveUpdate(snapshot, { type: 'counts-changed', mangaKey: 'nope::/none' })).toBe(snapshot);
});

it('emitted counts-changed patches the module snapshot with no reload', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  setLibrarySnapshot(snapshot);
  await patchChapterState(a.chapterKeys[1]!, a.key, { read: true });
  emitLibraryLive({ type: 'counts-changed', mangaKey: a.key });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));

  const deadline = Date.now() + 2000;
  let patched = getLibrarySnapshot();
  while ((!patched || patched === snapshot || patched.items.find(i => i.entry.key === a.key)?.unread !== 2) && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    patched = getLibrarySnapshot();
  }
  expect(patched).not.toBe(snapshot);
  expect(patched?.items.find(i => i.entry.key === a.key)?.unread).toBe(2);
});
