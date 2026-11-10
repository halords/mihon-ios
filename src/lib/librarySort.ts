import type { LibrarySort, Settings } from './settings';

export const LIBRARY_SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: 'title', label: 'Alphabetical' },
  { value: 'read', label: 'Last read' },
  { value: 'updated', label: 'Last update' },
  { value: 'unread', label: 'Unread count' },
  { value: 'chapters', label: 'Total chapters' },
  { value: 'latest', label: 'Latest chapter' },
  { value: 'fetched', label: 'Chapter fetch date' },
  { value: 'added', label: 'Date added' },
  { value: 'random', label: 'Random' },
];

export interface LibrarySortItem {
  key: string; title: string; added: number; read: number; unread: number;
  updated: number; chapters: number; latest: number; fetched: number;
}

function randomRank(key: string, seed: number): number {
  let hash = seed | 0;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function compareLibraryItems(a: LibrarySortItem, b: LibrarySortItem, settings: Settings): number {
  const alphabetical = a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  const mode = settings.librarySort;
  // Mihon keeps fully read titles below titles with unread chapters in
  // both directions. Equal values fall back to alphabetical order.
  if (mode === 'unread' && (!a.unread !== !b.unread)) return a.unread ? -1 : 1;
  const value = mode === 'title' ? alphabetical : mode === 'random'
    ? randomRank(a.key, settings.libraryRandomSeed) - randomRank(b.key, settings.libraryRandomSeed)
    : a[mode] - b[mode];
  return (settings.librarySortDirection === 'descending' ? -value : value) || alphabetical || a.key.localeCompare(b.key);
}

export function mihonLibrarySort(value: unknown): Pick<Settings, 'librarySort' | 'librarySortDirection'> | undefined {
  if (typeof value !== 'string') return;
  const [type, direction] = value.split(',');
  const modes: Record<string, LibrarySort> = {
    ALPHABETICAL: 'title', LAST_READ: 'read', LAST_MANGA_UPDATE: 'updated', UNREAD_COUNT: 'unread',
    TOTAL_CHAPTERS: 'chapters', LATEST_CHAPTER: 'latest', CHAPTER_FETCH_DATE: 'fetched', DATE_ADDED: 'added', RANDOM: 'random',
  };
  if (!type || !modes[type] || !['ASCENDING', 'DESCENDING'].includes(direction ?? '')) return;
  return { librarySort: modes[type], librarySortDirection: direction === 'ASCENDING' ? 'ascending' : 'descending' };
}
