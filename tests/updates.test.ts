import { afterEach, expect, it } from 'vitest';
import { checkLibraryUpdates, getLibraryUpdates } from '../src/lib/updates';
import { addToLibrary, getChapterMetas, putChapterMetas, putManga } from '../src/lib/db';
import { registerSource, unregisterSource } from '../src/sources';
import { testSource } from './fixtures/source';
afterEach(() => { unregisterSource('updates-good'); unregisterSource('updates-bad'); });
it('isolates unavailable sources, persists updates, and refreshes metadata without new chapters', async () => {
  const good = testSource('updates-good');
  const bad = testSource('updates-bad');
  bad.source.getChapterList = async () => { throw new Error('Offline source'); };
  for (const f of [good, bad]) { registerSource(f.source); const key = await putManga(f.manga); await addToLibrary(key, ['Reading']); await putChapterMetas(f.source.id, f.manga.id, [f.chapters[0]!]); }
  const result = await checkLibraryUpdates();
  expect(result).toMatchObject({ checked: 1, found: 1 });
  expect(result.failures[0]).toContain('Offline source');
  expect((await getLibraryUpdates())?.chapters).toHaveLength(1);
  good.chapters[0]!.name = 'Updated chapter title';
  const second = await checkLibraryUpdates();
  expect(second.found).toBe(0);
  expect(second.chapters).toHaveLength(1);
  expect((await getChapterMetas('updates-good::/hero'))[0]!.chapter.name).toBe('Updated chapter title');
});
