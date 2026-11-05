export type ReaderMode = 'vertical' | 'paged';
export type ThemeName = 'dark' | 'light';
export type LibraryView = 'grid' | 'list';

export interface Settings {
  readerMode: ReaderMode;
  theme: ThemeName;
  proxyBase: string;
  libraryView: LibraryView;
}

export const DEFAULT_SETTINGS: Settings = {
  readerMode: 'vertical',
  theme: 'dark',
  proxyBase: '',
  libraryView: 'grid',
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
      stored.readerMode === 'vertical' || stored.readerMode === 'paged'
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
    theme === 'light' ? '#ffffff' : '#121214',
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
