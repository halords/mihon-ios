import { expect, it } from 'vitest';
import { getRawDB, putManga, putChapterMetas, addToLibrary, getLibrary } from '../src/lib/db';
import { migrateManga } from '../src/lib/migration';
import { syncId } from '../src/lib/syncTypes';
import { testSource } from './fixtures/source';

it('migration with keepOriginal=false replaces the library entry and journals a tombstone', async () => {
  const a = testSource('test-source');
  const b = testSource('other-source');
  await putManga(a.manga); await putChapterMetas(a.source.id, a.manga.id, a.chapters);
  await addToLibrary('test-source::/hero', 'Reading');
  const result = await migrateManga('test-source::/hero', b.manga, b.chapters, false);
  expect(result.key).toBe('other-source::/hero');
  expect((await getLibrary()).map(entry => entry.key)).toEqual(['other-source::/hero']);
  const tombstone = await (await getRawDB()).get('syncRecords', syncId('library', 'test-source::/hero'));
  expect(tombstone?.deleted).toBe(true);
  expect(tombstone?.pending).toBe(true);
});

it('migration with keepOriginal=true keeps both library entries', async () => {
  const a = testSource('test-source');
  const b = testSource('other-source');
  await putManga(a.manga); await putChapterMetas(a.source.id, a.manga.id, a.chapters);
  await addToLibrary('test-source::/hero', 'Reading');
  await migrateManga('test-source::/hero', b.manga, b.chapters, true);
  expect((await getLibrary()).map(entry => entry.key).sort()).toEqual(['other-source::/hero', 'test-source::/hero']);
});
