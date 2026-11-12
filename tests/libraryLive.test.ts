import { expect, it, vi } from 'vitest';
import { registerSource } from '../src/sources';
import { chapterKey, mangaKey } from '../src/sources/Source';
import { addToLibrary, patchChapterState, putChapterMetas, putDownload, putManga, saveReadingProgress } from '../src/lib/db';
import { applyLibraryLiveUpdate, getLibrarySnapshot, loadLibrary, loadLibraryItem, setLibrarySnapshot } from '../src/lib/libraryData';
import { emitLibraryLive } from '../src/lib/libraryLive';
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

it('opening a title moves it first under the Last-read sort', async () => {
  await seedAll();
  const snapshot = await loadLibrary();
  const settings = loadSettings();
  expect(settings.librarySort).toBe('read');
  const before = [...snapshot.items].sort((x, y) => compareLibraryItems(x.sort, y.sort, settings));
  expect(before[0]!.entry.key).toBe(a.key);

  const next = await applyLibraryLiveUpdate(snapshot, { type: 'title-opened', mangaKey: b.key, openedAt: T9 });
  const after = [...next.items].sort((x, y) => compareLibraryItems(x.sort, y.sort, settings));
  expect(after[0]!.entry.key).toBe(b.key);
  expect(next.items.find(i => i.entry.key === b.key)!.lastRead).toBe(T9);

  // Unknown titles and stale opens are no-ops (same reference, no re-render).
  expect(await applyLibraryLiveUpdate(next, { type: 'title-opened', mangaKey: 'nope::/none', openedAt: T9 })).toBe(next);
  expect(await applyLibraryLiveUpdate(next, { type: 'title-opened', mangaKey: b.key, openedAt: T1 })).toBe(next);
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
