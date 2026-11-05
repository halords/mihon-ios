import { useEffect, useState } from 'react';
import {
  addToLibrary,
  getChapterMetas,
  getChapterStates,
  getLibraryEntry,
  getManga,
  putChapterMetas,
  putManga,
  removeFromLibrary,
  setLibraryCategory,
  type ChapterStateRecord,
} from '../lib/db';
import { useNav } from '../lib/nav';
import { useLoad } from '../lib/useLoad';
import DownloadButton from '../components/DownloadButton';
import { deleteMangaDownloads } from '../lib/downloads';
import { getSource } from '../sources';
import {
  CATEGORIES,
  chapterKey,
  type SChapter,
  type SManga,
} from '../sources/Source';

export function MangaDetailsPage({ mangaKey }: { mangaKey: string }) {
  const { back, openReader } = useNav();
  const separator = mangaKey.indexOf('::');
  const sourceId = mangaKey.slice(0, separator);
  const mangaId = mangaKey.slice(separator + 2);

  const [expanded, setExpanded] = useState(false);
  const [showSheet, setShowSheet] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(false);
    setShowSheet(false);
    setActionError(null);
  }, [mangaKey]);

  useEffect(() => {
    if (!showSheet) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setShowSheet(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showSheet]);

  const { data, loading, error, reload } = useLoad(async () => {
    const cached = await getManga(mangaKey);
    const source = getSource(sourceId);
    const sourceOk = !!source && (cached?.sourceAvailable ?? true);

    let details: SManga;
    let chapters: SChapter[];

    if (source) {
      details = await source.getMangaDetails(mangaId);
      chapters = await source.getChapterList(mangaId);
      await putManga(details, true);
      await putChapterMetas(sourceId, mangaId, chapters);
    } else {
      if (!cached?.manga) {
        throw new Error('This manga is not available offline yet.');
      }

      details = cached.manga;
      chapters = (await getChapterMetas(mangaKey)).map(
        (record) => record.chapter,
      );
    }

    const states = await getChapterStates(mangaKey);
    const stateByKey: Record<string, ChapterStateRecord> = {};

    for (const state of states) {
      stateByKey[state.key] = state;
    }

    const entry = await getLibraryEntry(mangaKey);

    return {
      manga: details,
      chapters: [...chapters].sort((a, b) => a.number - b.number),
      stateByKey,
      inLibrary: !!entry,
      category: entry?.category,
      sourceOk,
    };
  }, [mangaKey, sourceId, mangaId]);

  // Refresh chapter states when a download finishes or is deleted.
  useEffect(() => {
    function onDownloadsChanged(): void {
      reload();
    }
    window.addEventListener('mihon:downloads-changed', onDownloadsChanged);
    return () => {
      window.removeEventListener('mihon:downloads-changed', onDownloadsChanged);
    };
  }, [reload]);

  const topbar = (
    <header className="topbar">
      <button type="button" className="btn-ghost" onClick={back}>
        Back
      </button>
      <h1>Manga details</h1>
    </header>
  );

  if (loading) {
    return (
      <div className="screen">
        {topbar}
        <div className="spinner" role="status" aria-label="Loading manga details" />
      </div>
    );
  }

  if (error !== null || data === null) {
    return (
      <div className="screen">
        {topbar}
        <div className="error">
          <p role="alert">{error ?? 'Manga details could not be loaded.'}</p>
          <button type="button" className="btn" onClick={reload}>
            Retry
          </button>
          <button type="button" className="btn-ghost" onClick={back}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const { manga, chapters, stateByKey, inLibrary, category, sourceOk } = data;
  const sourceName = getSource(sourceId)?.name ?? sourceId;
  const creators = [manga.author, manga.artist].filter(Boolean).join(' / ');
  const firstUnread = chapters.find(
    (chapter) => !stateByKey[chapterKey(sourceId, mangaId, chapter.id)]?.read,
  );
  const anyRead = chapters.some(
    (chapter) => stateByKey[chapterKey(sourceId, mangaId, chapter.id)]?.read,
  );
  const anyDownloaded = chapters.some(
    (chapter) => stateByKey[chapterKey(sourceId, mangaId, chapter.id)]?.downloaded,
  );

  async function deleteAllDownloads(): Promise<void> {
    if (!window.confirm('Delete all downloaded chapters for this manga?')) {
      return;
    }
    await deleteMangaDownloads(mangaKey);
    window.dispatchEvent(new Event('mihon:downloads-changed'));
  }

  async function updateLibrary(action: () => Promise<unknown>): Promise<void> {
    if (mutating) {
      return;
    }

    setMutating(true);
    setActionError(null);

    try {
      await action();
      setShowSheet(false);
      reload();
    } catch (cause: unknown) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  }

  return (
    <div className="screen">
      {topbar}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <img referrerPolicy="no-referrer"
          src={manga.coverUrl}
          alt={manga.title}
          style={{
            width: 112,
            height: 150,
            objectFit: 'cover',
            borderRadius: 10,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ marginTop: 0 }}>{manga.title}</h2>
          {creators && <p style={{ color: 'var(--dim)' }}>{creators}</p>}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span className="chip">{manga.status}</span>
            <small style={{ color: 'var(--dim)' }}>{sourceName}</small>
          </div>
        </div>
      </div>

      {manga.genres.length > 0 && (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}
        >
          {manga.genres.map((genre) => (
            <span key={genre} className="chip">
              {genre}
            </span>
          ))}
        </div>
      )}

      {!sourceOk && (
        <div className="card" style={{ marginTop: 16 }}>
          Source not available in PWA yet — showing backup data. Reading will be
          available once a web source for it exists.
        </div>
      )}

      <p
        style={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 3,
                overflow: 'hidden',
              }
        }
      >
        {manga.description}
      </p>
      <button
        type="button"
        className="btn-ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'Less' : 'More'}
      </button>

      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}
      >
        {chapters.length > 0 && (
          <button
            type="button"
            className="btn"
            disabled={!sourceOk || !firstUnread}
            onClick={() => {
              if (sourceOk && firstUnread) {
                openReader(mangaKey, firstUnread.id);
              }
            }}
          >
            {firstUnread
              ? `${anyRead ? 'Continue' : 'Start reading'} — ${firstUnread.name}`
              : 'All caught up'}
          </button>
        )}

        {inLibrary ? (
          <button
            type="button"
            className="btn-ghost"
            disabled={mutating}
            aria-haspopup="dialog"
            aria-expanded={showSheet}
            onClick={() => {
              setActionError(null);
              setShowSheet(true);
            }}
          >
            In Library · {category ?? 'Default'}
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost"
            disabled={mutating}
            onClick={() => {
              void updateLibrary(() => addToLibrary(mangaKey, 'Default'));
            }}
          >
            Add to Library
          </button>
        )}
      </div>

      {actionError !== null && !showSheet && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      <section aria-label="Chapters">
        <h3>Chapters ({chapters.length})</h3>
        {anyDownloaded && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void deleteAllDownloads()}
            style={{ marginBottom: 8 }}
          >
            Delete all downloads
          </button>
        )}
        {chapters.length === 0 ? (
          <div className="empty">No chapters yet.</div>
        ) : (
          [...chapters].reverse().map((chapter) => {
            const key = chapterKey(sourceId, mangaId, chapter.id);
            const state = stateByKey[key];

            return (
              <div key={key} className="list-row" style={{ width: '100%' }}>
                <button
                  type="button"
                  disabled={!sourceOk}
                  onClick={() => {
                    if (sourceOk) {
                      openReader(mangaKey, chapter.id);
                    }
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    font: 'inherit',
                    cursor: sourceOk ? 'pointer' : 'default',
                    color: state?.read ? 'var(--dim)' : 'var(--text)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>{chapter.name}</div>
                    <small style={{ color: 'var(--dim)' }}>
                      {new Date(chapter.dateUpload).toLocaleDateString()}
                    </small>
                  </div>
                  {state?.read && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--dim)' }}>
                      READ
                    </span>
                  )}
                </button>
                {sourceOk && (
                  <DownloadButton
                    mangaKey={mangaKey}
                    sourceId={sourceId}
                    mangaId={mangaId}
                    chapterId={chapter.id}
                    downloaded={!!state?.downloaded}
                  />
                )}
              </div>
            );
          })
        )}
      </section>

      {showSheet && (
        <div
          onClick={() => setShowSheet(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.55)',
            zIndex: 1000,
          }}
        >
          <div
            className="menu-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Library category"
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxHeight: '85dvh',
              overflowY: 'auto',
            }}
          >
            <h3>Library category</h3>
            {CATEGORIES.map((nextCategory) => (
              <button
                key={nextCategory}
                type="button"
                className="btn-ghost"
                disabled={mutating}
                autoFocus={nextCategory === (category ?? 'Default')}
                aria-pressed={nextCategory === category}
                onClick={() => {
                  void updateLibrary(() =>
                    setLibraryCategory(mangaKey, nextCategory),
                  );
                }}
              >
                {nextCategory === category ? '✓ ' : ''}
                {nextCategory}
              </button>
            ))}
            <button
              type="button"
              className="btn-danger"
              disabled={mutating}
              onClick={() => {
                void updateLibrary(() => removeFromLibrary(mangaKey));
              }}
            >
              Remove from Library
            </button>
            {actionError !== null && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowSheet(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default MangaDetailsPage;
