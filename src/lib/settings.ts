export type ReaderMode = 'vertical' | 'paged' | 'rtl';
export type ThemeName = 'dark' | 'light';
export type LibraryView = 'grid' | 'list';
export type LibrarySort = 'title' | 'added' | 'read' | 'unread' | 'updated' | 'chapters' | 'latest' | 'fetched' | 'random';

export interface Settings {
  readerMode: ReaderMode;
  theme: ThemeName;
  proxyBase: string;
  libraryView: LibraryView;
  extensionIndexes: string[];
  downloadedOnly: boolean;
  librarySort: LibrarySort;
  librarySortDirection: 'ascending' | 'descending';
  libraryRandomSeed: number;
  dataSaver: boolean;
  continuousReading: boolean;
  readerFit: 'width' | 'screen';
  suwayomiUrl: string;
  chapterLanguages: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  readerMode: 'vertical',
  theme: 'dark',
  proxyBase: '',
  libraryView: 'grid',
  extensionIndexes: [],
  downloadedOnly: false,
  librarySort: 'read',
  librarySortDirection: 'descending',
  libraryRandomSeed: 1,
  dataSaver: true,
  continuousReading: true,
  readerFit: 'screen',
  suwayomiUrl: '',
  chapterLanguages: ['en'],
};

const STORAGE_KEY = 'mihon-settings';
const listeners = new Set<(settings: Settings) => void>();

function normalizeSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS };
  }

  const stored = value as Record<string, unknown>;

  return {
    ...DEFAULT_SETTINGS,
    readerMode:
      stored.readerMode === 'vertical' || stored.readerMode === 'paged' || stored.readerMode === 'rtl'
        ? stored.readerMode
        : DEFAULT_SETTINGS.readerMode,
    theme:
      stored.theme === 'dark' || stored.theme === 'light'
        ? stored.theme
        : DEFAULT_SETTINGS.theme,
    proxyBase:
      typeof stored.proxyBase === 'string'
        ? stored.proxyBase
        : DEFAULT_SETTINGS.proxyBase,
    libraryView:
      stored.libraryView === 'grid' || stored.libraryView === 'list'
        ? stored.libraryView
        : DEFAULT_SETTINGS.libraryView,
    extensionIndexes: Array.isArray(stored.extensionIndexes)
      ? stored.extensionIndexes.filter(
          (value): value is string =>
            typeof value === 'string' && value.length > 0,
        )
      : DEFAULT_SETTINGS.extensionIndexes,
    downloadedOnly: stored.downloadedOnly === true,
    librarySort: ['title', 'added', 'read', 'unread', 'updated', 'chapters', 'latest', 'fetched', 'random'].includes(String(stored.librarySort))
      ? stored.librarySort as LibrarySort : DEFAULT_SETTINGS.librarySort,
    librarySortDirection: stored.librarySortDirection === 'ascending' || stored.librarySortDirection === 'descending'
      ? stored.librarySortDirection
      // Earlier versions called this checkbox "Reverse order": numeric
      // modes started largest first, while titles started alphabetically.
      : typeof stored.sortDescending === 'boolean'
        ? (stored.librarySort === 'title' ? stored.sortDescending : !stored.sortDescending) ? 'descending' : 'ascending'
        : DEFAULT_SETTINGS.librarySortDirection,
    libraryRandomSeed: Number.isSafeInteger(stored.libraryRandomSeed) ? Number(stored.libraryRandomSeed) : DEFAULT_SETTINGS.libraryRandomSeed,
    dataSaver: stored.dataSaver !== false,
    continuousReading: stored.continuousReading !== false,
    readerFit: stored.readerFit === 'width' ? 'width' : 'screen',
    suwayomiUrl: typeof stored.suwayomiUrl === 'string' ? stored.suwayomiUrl.replace(/\/+$/, '') : '',
    chapterLanguages: Array.isArray(stored.chapterLanguages) && stored.chapterLanguages.some(v => typeof v === 'string' && v.length > 0)
      ? [...new Set(stored.chapterLanguages.filter((v): v is string => typeof v === 'string' && v.length > 0))]
      : ['en'],
  };
}

export function loadSettings(): Settings {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);

    if (stored === null) {
      return { ...DEFAULT_SETTINGS };
    }

    const parsed: unknown = JSON.parse(stored);
    return normalizeSettings(parsed);
  } catch {
    // Invalid JSON and unavailable storage should not prevent startup.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const settings = normalizeSettings({ ...loadSettings(), ...patch });

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Still apply and publish changes when persistence is unavailable.
    }
  }

  applyTheme(settings.theme);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<Settings>('mihon:settings', { detail: settings }),
    );
  }

  for (const listener of [...listeners]) {
    listener(settings);
  }

  return settings;
}

export function applyTheme(theme: ThemeName): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.dataset.theme = theme;

  const themeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );

  themeColor?.setAttribute(
    'content',
    theme === 'light' ? '#fffbff' : '#141318',
  );
}

export function onSettingsChange(
  fn: (settings: Settings) => void,
): () => void {
  listeners.add(fn);

  return () => {
    listeners.delete(fn);
  };
}
