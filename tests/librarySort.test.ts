import { expect, it } from 'vitest';
import { compareLibraryItems, mihonLibrarySort, type LibrarySortItem } from '../src/lib/librarySort';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/lib/settings';
import { inspectTachibkFile, restoreTachibk } from '../src/backup/tachibk';
import { concat, schemaBackup, preference, string } from './fixtures/mihon';

const item = (key: string, title: string, read: number): LibrarySortItem => ({ key, title, read, unread: 1, added: 0, updated: 0, chapters: 0, latest: 0, fetched: 0 });

it('sorts newest reading history first, never-read titles last, and ties alphabetically', () => {
  const entries = [item('never', 'Never read', 0), item('old', 'Old read', 1), item('b', 'Beta', 3), item('a', 'Alpha', 3)];
  expect(entries.sort((a, b) => compareLibraryItems(a, b, DEFAULT_SETTINGS)).map(i => i.key)).toEqual(['a', 'b', 'old', 'never']);
  expect(entries.sort((a, b) => compareLibraryItems(a, b, { ...DEFAULT_SETTINGS, librarySortDirection: 'ascending' })).map(i => i.key)).toEqual(['never', 'old', 'a', 'b']);
});

it('preserves legacy title and numeric order when upgrading persisted settings', () => {
  for (const [mode, reverse, direction] of [['title', false, 'ascending'], ['title', true, 'descending'], ['read', false, 'descending'], ['read', true, 'ascending']] as const) {
    localStorage.setItem('mihon-settings', JSON.stringify({ librarySort: mode, sortDescending: reverse }));
    expect(loadSettings().librarySortDirection).toBe(direction);
    saveSettings({ libraryView: 'list' });
    expect(loadSettings().librarySortDirection).toBe(direction);
  }
});

it('keeps unread titles ahead of fully read titles in either direction and makes random ordering stable', () => {
  const read = { ...item('read', 'Alpha', 0), unread: 0 };
  const unread = item('unread', 'Beta', 0);
  for (const direction of ['ascending', 'descending'] as const) expect(compareLibraryItems(unread, read, { ...DEFAULT_SETTINGS, librarySort: 'unread', librarySortDirection: direction })).toBeLessThan(0);
  const entries = Array.from({ length: 30 }, (_, n) => item(String(n), `Title ${n}`, 0));
  const sorted = (seed: number) => [...entries].sort((a, b) => compareLibraryItems(a, b, { ...DEFAULT_SETTINGS, librarySort: 'random', libraryRandomSeed: seed })).map(i => i.key);
  expect(sorted(1)).toEqual(sorted(1));
  expect(sorted(2)).not.toEqual(sorted(1));
});

it('restores Mihon LAST_READ,DESCENDING only when matching preferences are enabled', async () => {
  const bytes = concat(schemaBackup(), preference('library_sorting_mode', 'StringPreferenceValue', string(1, 'LAST_READ,DESCENDING')));
  const preview = await inspectTachibkFile(new Blob([bytes]));
  saveSettings({ librarySort: 'title', librarySortDirection: 'ascending' });
  await restoreTachibk(preview, { restorePreferences: false });
  expect(loadSettings()).toMatchObject({ librarySort: 'title', librarySortDirection: 'ascending' });
  await restoreTachibk(preview, { restorePreferences: true });
  expect(loadSettings()).toMatchObject({ librarySort: 'read', librarySortDirection: 'descending' });
  expect(mihonLibrarySort('TOTAL_CHAPTERS,ASCENDING')).toEqual({ librarySort: 'chapters', librarySortDirection: 'ascending' });
  expect(mihonLibrarySort('LAST_READ,invalid')).toBeUndefined();
});
