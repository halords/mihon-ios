import { useEffect, useState } from 'react';
import { MangaGrid, MangaList } from '../components/MangaViews';
import { putManga } from '../lib/db';
import { useNav } from '../lib/nav';
import { loadSettings, onSettingsChange } from '../lib/settings';
import { useLoad } from '../lib/useLoad';
import { sources } from '../sources';
import { mangaKey } from '../sources/Source';

export function BrowsePage() {
  const { openManga } = useNav();
  const [mode, setMode] = useState<'popular' | 'latest'>('popular');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [libraryView, setLibraryView] = useState(
    () => loadSettings().libraryView,
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

  const { data, loading, error, reload } = useLoad(async () => {
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

    return results.flat();
  }, [mode, debouncedQuery]);

  const items = (data ?? []).map((manga) => ({
    key: mangaKey(manga.sourceId, manga.id),
    manga,
  }));

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
        <MangaList items={items} onOpen={openManga} />
      ) : (
        <MangaGrid items={items} onOpen={openManga} />
      )}
    </div>
  );
}

export default BrowsePage;
