import { useCallback, useEffect, useRef, useState } from 'react';
import { MangaGrid, MangaList } from '../components/MangaViews';
import {
  loadBrowseState,
  saveBrowseState,
  type BrowseState,
} from '../lib/browseState';
import {
  addToLibrary,
  getLibrary,
  putManga,
  removeFromLibrary,
  setLibraryCategory,
} from '../lib/db';
import { useNav } from '../lib/nav';
import { loadSettings, onSettingsChange } from '../lib/settings';
import { useLoad } from '../lib/useLoad';
import { sources } from '../sources';
import { CATEGORIES, mangaKey } from '../sources/Source';

export function BrowsePage() {
  const { openManga } = useNav();
  // Restore the previous Browse snapshot (query, mode, results, scroll) so
  // coming back from a manga or another tab feels like a native app.
  const [initialState] = useState<BrowseState | null>(() => loadBrowseState());
  const [mode, setMode] = useState<'popular' | 'latest'>(
    () => initialState?.mode ?? 'popular',
  );
  const [query, setQuery] = useState(() => initialState?.query ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(
    () => initialState?.query ?? '',
  );
  const restoreRef = useRef<BrowseState | null>(initialState);
  const scrollYRef = useRef(initialState?.scrollY ?? 0);
  const scrollRestoredRef = useRef(false);
  const [libraryView, setLibraryView] = useState(
    () => loadSettings().libraryView,
  );
  const [libraryMap, setLibraryMap] = useState<Record<string, string>>({});
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);

  const refreshLibrary = useCallback(
    async (isActive: () => boolean = () => true): Promise<void> => {
      const records = await getLibrary();

      if (isActive()) {
        setLibraryMap(
          Object.fromEntries(
            records.map((record) => [record.key, record.category]),
          ),
        );
      }
    },
    [],
  );

  const searching = query.trim().length > 0;
  const waitingForDebounce = query.trim() !== debouncedQuery;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const unsubscribe = onSettingsChange(() => {
      setLibraryView(loadSettings().libraryView);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;

    void refreshLibrary(() => active).catch(() => {});

    return () => {
      active = false;
    };
  }, [refreshLibrary]);

  useEffect(() => {
    if (menuKey === null) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !menuBusy) {
        setMenuKey(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuKey, menuBusy]);

  const { data, loading, error, reload } = useLoad(async () => {
    // First load after a remount: if the stored snapshot matches this
    // query/mode, serve it as-is instead of refetching.
    const stored = restoreRef.current;
    restoreRef.current = null;
    if (
      stored &&
      stored.query === debouncedQuery &&
      stored.mode === mode &&
      stored.items.length > 0
    ) {
      return stored.items;
    }

    const results = await Promise.all(
      sources.map(async (source) => {
        const mangas = debouncedQuery
          ? await source.searchManga(debouncedQuery, 1)
          : mode === 'popular'
            ? await source.getPopularManga(1)
            : await source.getLatestUpdates(1);

        for (const manga of mangas) {
          void putManga(manga, true).catch(() => {});
        }

        return mangas;
      }),
    );

    const flat = results.flat();
    saveBrowseState({
      query: debouncedQuery,
      mode,
      items: flat,
      scrollY: scrollYRef.current,
    });
    return flat;
  }, [mode, debouncedQuery]);

  // Track the scroll position (throttled via rAF) and persist it on
  // unmount, so Back lands exactly where the user left the list.
  useEffect(() => {
    let ticking = false;

    function persistScroll(): void {
      scrollYRef.current = window.scrollY;
      const current = loadBrowseState();
      if (current) {
        saveBrowseState({ ...current, scrollY: window.scrollY });
      }
    }

    function onScroll(): void {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        persistScroll();
      });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      persistScroll();
    };
  }, []);

  // Restore the scroll position once the (restored or freshly loaded)
  // results have rendered.
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    if (loading || !data || data.length === 0) return;

    scrollRestoredRef.current = true;
    const target = initialState?.scrollY ?? 0;
    if (target <= 0) return;

    window.requestAnimationFrame(() => {
      window.scrollTo(0, target);
      window.setTimeout(() => {
        if (Math.abs(window.scrollY - target) > 4) {
          window.scrollTo(0, target);
        }
      }, 60);
    });
  }, [loading, data, initialState]);

  const items = (data ?? []).map((manga) => {
    const key = mangaKey(manga.sourceId, manga.id);

    return {
      key,
      manga,
      inLibrary: libraryMap[key] !== undefined,
    };
  });

  const menuItem = items.find((item) => item.key === menuKey);
  const menuInLibrary = menuItem
    ? libraryMap[menuItem.key] !== undefined
    : false;
  const menuCategory = menuItem ? libraryMap[menuItem.key] : undefined;

  async function runMenuAction(action: () => Promise<void>): Promise<void> {
    if (menuBusy) return;

    setMenuBusy(true);
    setMenuError(null);

    try {
      await action();
      await refreshLibrary();
      setMenuKey(null);
    } catch (cause) {
      setMenuError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMenuBusy(false);
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <h1>Browse</h1>
      </header>

      <div className="searchbar">
        <input
          type="search"
          aria-label="Search manga"
          placeholder="Search manga…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query !== '' && (
          <button
            type="button"
            className="btn-ghost"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >
            Clear
          </button>
        )}
      </div>

      {!searching && (
        <div className="seg" role="group" aria-label="Browse mode">
          <button
            type="button"
            className={mode === 'popular' ? 'active' : ''}
            aria-pressed={mode === 'popular'}
            onClick={() => setMode('popular')}
          >
            Popular
          </button>
          <button
            type="button"
            className={mode === 'latest' ? 'active' : ''}
            aria-pressed={mode === 'latest'}
            onClick={() => setMode('latest')}
          >
            Latest
          </button>
        </div>
      )}

      {loading || waitingForDebounce ? (
        <div className="spinner" role="status" aria-label="Loading manga" />
      ) : error !== null ? (
        <div className="error">
          <p role="alert">{error}</p>
          <button type="button" className="btn" onClick={reload}>
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">No results.</div>
      ) : libraryView === 'list' ? (
        <MangaList
          items={items}
          onOpen={openManga}
          onMenu={(key) => {
            setMenuError(null);
            setMenuKey(key);
          }}
        />
      ) : (
        <MangaGrid
          items={items}
          onOpen={openManga}
          onMenu={(key) => {
            setMenuError(null);
            setMenuKey(key);
          }}
        />
      )}

      {menuItem && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 1000,
          }}
          onClick={() => {
            if (!menuBusy) {
              setMenuKey(null);
            }
          }}
        >
          <div
            className="menu-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Library options for ${menuItem.manga.title}`}
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <h3>{menuItem.manga.title}</h3>

            {!menuInLibrary && (
              <button
                type="button"
                className="btn"
                disabled={menuBusy}
                onClick={() => {
                  void runMenuAction(async () => {
                    await putManga(menuItem.manga, true);
                    await addToLibrary(menuItem.key, 'Default');
                  });
                }}
              >
                Add to Library
              </button>
            )}

            <p style={{ color: 'var(--dim)', margin: 0 }}>
              {menuInLibrary ? 'Move to category' : 'Add to category'}
            </p>

            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                className="btn-ghost"
                disabled={menuBusy || (menuInLibrary && cat === menuCategory)}
                onClick={() => {
                  void runMenuAction(async () => {
                    if (menuInLibrary) {
                      await setLibraryCategory(menuItem.key, cat);
                    } else {
                      await putManga(menuItem.manga, true);
                      await addToLibrary(menuItem.key, cat);
                    }
                  });
                }}
              >
                {(menuInLibrary && cat === menuCategory ? '✓ ' : '') + cat}
              </button>
            ))}

            {menuInLibrary && (
              <button
                type="button"
                className="btn-danger"
                disabled={menuBusy}
                onClick={() => {
                  void runMenuAction(() => removeFromLibrary(menuItem.key));
                }}
              >
                Remove from Library
              </button>
            )}

            {menuError && (
              <p className="error" role="alert">
                {menuError}
              </p>
            )}

            <button
              type="button"
              className="btn-ghost"
              disabled={menuBusy}
              onClick={() => setMenuKey(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default BrowsePage;
