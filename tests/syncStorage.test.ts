import { beforeEach, expect, it, vi } from 'vitest';
import { getDB, getRawDB, putManga, addToLibrary, removeFromLibrary, patchChapterState, saveReadingProgress, getLibrary, getHistory, getChapterState } from '../src/lib/db';
import { acknowledgeChanges, activateAccountProfile, applyRemoteChanges } from '../src/lib/account';
import { setSyncProfileContext, syncNativeStore } from '../src/lib/syncStorage';
import { syncId, type RemoteChange } from '../src/lib/syncTypes';
beforeEach(() => setSyncProfileContext('guest'));
const key = 'mangadex::hero'; const chapter = key + '::one';
async function seed() { await putManga({ id: 'hero', sourceId: 'mangadex', title: 'Hero', coverUrl: '', genres: [], description: '', status: 'Ongoing' }); await addToLibrary(key, 'Reading'); }

it('commits changes with their queue entries, rolls them back together, and records removals', async () => {
  await seed(); const db = await getDB();
  const tx = db.transaction(['library', 'history'], 'readwrite');
  await tx.objectStore('library').delete(key); tx.abort(); await tx.done.catch(() => {});
  expect(await getLibrary()).toHaveLength(1);
  expect((await db.get('syncRecords', syncId('library', key)))?.deleted).toBe(false);
  await removeFromLibrary(key);
  expect((await db.get('syncRecords', syncId('library', key)))?.deleted).toBe(true);
});
it('syncs explicit unread marks and history removals, while downloaded flags stay local', async () => {
  await seed(); const db = await getDB();
  await saveReadingProgress({ key: chapter, mangaKey: key, mangaTitle: 'Hero', coverUrl: '', chapterName: 'Chapter 1', page: 5, updatedAt: 100 }, true);
  const first = await db.get('syncRecords', syncId('chapterState', chapter));
  await patchChapterState(chapter, key, { downloaded: true });
  expect((await db.get('syncRecords', first!.id))?.clock).toBe(first!.clock);
  await patchChapterState(chapter, key, { read: false, lastPage: 0 });
  const unread = await db.get('syncRecords', first!.id);
  expect(unread?.data).toMatchObject({ read: false, lastPage: 0 }); expect(unread?.data?.downloaded).toBeUndefined();
  await db.clear('history'); expect((await db.get('syncRecords', syncId('history', chapter)))?.deleted).toBe(true);
});
it('keeps writes made during upload pending and applies newer remote states without losing local downloads', async () => {
  await seed(); await activateAccountProfile('user-a');
  await patchChapterState(chapter, key, { read: true, downloaded: true });
  const db = await getDB(); const sent = (await db.get('syncRecords', syncId('chapterState', chapter)))!;
  await patchChapterState(chapter, key, { read: false, lastPage: 0 });
  await acknowledgeChanges([sent], 'user-a'); expect((await db.get('syncRecords', sent.id))?.pending).toBe(true);
  const current = (await db.get('syncRecords', sent.id))!;
  const remote: RemoteChange = { ...current, clock: current.clock + 1, deviceId: 'other-device', revision: 20, data: { ...current.data, read: true, lastPage: 9 } };
  await applyRemoteChanges([remote], 20, 'user-a');
  expect(await getChapterState(chapter)).toMatchObject({ read: true, lastPage: 9, downloaded: true });
  expect((await db.get('syncRecords', sent.id))?.pending).toBe(false);
});
it('separates account profiles and rejects a remote page for the wrong active account', async () => {
  await seed(); await activateAccountProfile('user-a'); expect(await getLibrary()).toHaveLength(0);
  await seed(); await saveReadingProgress({ key: chapter, mangaKey: key, mangaTitle: 'Hero', coverUrl: '', chapterName: 'One', page: 4, updatedAt: 300 }, false);
  await activateAccountProfile('user-b'); expect(await getLibrary()).toHaveLength(0); expect(await getHistory()).toHaveLength(0);
  await expect(applyRemoteChanges([], 20, 'user-a')).rejects.toThrow('active account changed');
  await activateAccountProfile('user-a'); expect(await getLibrary()).toHaveLength(1); expect(await getHistory()).toHaveLength(1);
  expect((await (await getRawDB()).get('syncProfiles', 'guest'))?.stores.library).toHaveLength(1);
});
it('journals native import writes after the persisted clock and aborts writes from an old account tab', async () => {
  const raw = await getRawDB(); const db = await getDB();
  const future = Date.now() + 86400000;
  await raw.put('syncControl', { key: 'clock', value: future });
  let tx = db.transaction('library', 'readwrite');
  syncNativeStore(tx.store).put({ key, category: 'Reading', addedAt: 10 });
  await tx.done;
  expect((await raw.get('syncRecords', syncId('library', key)))!.clock).toBeGreaterThan(future);
  await raw.put('syncControl', { key: 'owner', value: 'another-account' });
  tx = db.transaction('library', 'readwrite');
  syncNativeStore(tx.store).put({ key: 'mangadex::other', category: 'Reading', addedAt: 10 });
  await expect(tx.done).rejects.toThrow();
  expect(await raw.get('library', 'mangadex::other')).toBeUndefined();
  await expect(acknowledgeChanges([], 'guest')).rejects.toThrow('active account changed');
});
it('keeps local writes available when localStorage access is denied', async () => {
  const getter = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
  try {
    await seed(); const raw = await getRawDB();
    const record = (await raw.get('syncRecords', syncId('library', key)))!;
    await addToLibrary('mangadex::second', 'Reading');
    expect((await raw.get('syncRecords', syncId('library', 'mangadex::second')))!.deviceId).toBe(record.deviceId);
    expect(await getLibrary()).toHaveLength(2);
  } finally { getter.mockRestore(); }
});
