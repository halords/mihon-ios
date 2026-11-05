import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import {
  chapterKey,
  type SChapter,
  type SManga,
} from '../sources/Source';
import { getSource } from '../sources';
import {
  getManga,
  putManga,
  getChapterMetas,
  putChapterMetas,
  getChapterState,
  patchChapterState,
  putHistory,
  getDownload,
} from '../lib/db';
import {
  isChapterCached,
  resolveChapterPages,
  revokeBlobUrls,
} from '../lib/downloads';
import { loadSettings, saveSettings } from '../lib/settings';
import { useNav } from '../lib/nav';
import { useLoad } from '../lib/useLoad';

type ReaderMode = 'vertical' | 'paged';

interface ReaderData {
  manga: SManga;
  chapters: SChapter[];
  current: SChapter;
  pages: string[];
  prev: SChapter | undefined;
  next: SChapter | undefined;
  initialPage: number;
  cKey: string;
}

interface ProgressSession {
  data: ReaderData;
  mangaKey: string;
}

function clampPage(value: number, count: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(normalized, Math.max(0, count - 1)));
}

function chapterNumber(chapter: SChapter): number | undefined {
  if (
    'number' in chapter &&
    typeof chapter.number === 'number' &&
    Number.isFinite(chapter.number)
  ) {
    return chapter.number;
  }

  if (
    'chapterNumber' in chapter &&
    typeof chapter.chapterNumber === 'number' &&
    Number.isFinite(chapter.chapterNumber)
  ) {
    return chapter.chapterNumber;
  }

  return undefined;
}

function compareChapters(a: SChapter, b: SChapter): number {
  const aNumber = chapterNumber(a);
  const bNumber = chapterNumber(b);

  if (aNumber !== undefined && bNumber !== undefined && aNumber !== bNumber) {
    return aNumber - bNumber;
  }

  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export default function ReaderPage({
  mangaKey,
  chapterId,
}: {
  mangaKey: string;
  chapterId: string;
}) {
  const nav = useNav();
  const [sourceId = '', mangaId = ''] = mangaKey.split('::');
  const expectedKey = chapterKey(sourceId, mangaId, chapterId);

  const [mode, setMode] = useState<ReaderMode>(
    () => loadSettings().readerMode,
  );
  const [page, setPage] = useState(0);
  const [finished, setFinished] = useState(false);
  const [showBar, setShowBar] = useState(true);
  const [readyKey, setReadyKey] = useState<string | null>(null);

  const screenRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(0);
  const sessionRef = useRef<ProgressSession | null>(null);
  const initializedKeyRef = useRef<string | null>(null);
  const resumedRef = useRef(false);
  const restoringRef = useRef(false);
  const lastProgressTimeRef = useRef(-Infinity);
  const writesRef = useRef<Promise<void>>(Promise.resolve());

  // Floating reader chrome: shown briefly on chapter entry, toggled by a
  // center tap, and auto-hidden after ~3s without interaction (Mihon-style).
  useEffect(() => {
    if (!showBar) return;
    const timer = window.setTimeout(() => setShowBar(false), 3000);
    return () => window.clearTimeout(timer);
  }, [showBar, expectedKey]);

  const toggleChrome = useCallback(() => {
    setShowBar((visible) => !visible);
  }, []);

  const { data, loading, error, reload } = useLoad<ReaderData>(
    async () => {
      const source = getSource(sourceId);
      if (!source) {
        throw new Error(
          'Source not available in PWA yet — this manga cannot be read until a web source exists.',
        );
      }

      const stored = await getManga(mangaKey);
      const manga = stored?.manga ?? await source.getMangaDetails(mangaId);

      if (!stored?.manga) {
        await putManga(manga);
      }

      let metas = await getChapterMetas(mangaKey);
      if (metas.length === 0) {
        const chapters = await source.getChapterList(mangaId);
        await putChapterMetas(sourceId, mangaId, chapters);
        metas = await getChapterMetas(mangaKey);
      }

      const chapters = metas.map((meta) => meta.chapter).sort(compareChapters);
      const current = chapters.find((chapter) => chapter.id === chapterId);
      if (!current) {
        throw new Error('Chapter not found');
      }

      const cKey = chapterKey(sourceId, mangaId, chapterId);
      const state = await getChapterState(cKey);
      let pages: string[];
      const dl = state?.downloaded ? await getDownload(cKey) : undefined;
      if (dl && dl.pageCount > 0 && (await isChapterCached(cKey, dl.pageCount))) {
        // Downloaded chapter: serve every page from Cache Storage so it
        // reads end-to-end offline (airplane mode), no source call needed.
        pages = await resolveChapterPages(
          cKey,
          new Array<string>(dl.pageCount).fill(''),
        );
      } else {
        pages = (await source.getPageList(chapterId)).map(
          (entry) => entry.imageUrl,
        );
      }
      // Prev/next navigation only walks chapters that are readable in-app;
      // external chapters have no pages here.
      const readable = chapters.filter((chapter) => !chapter.external);
      const readableIndex = readable.findIndex(
        (chapter) => chapter.id === chapterId,
      );

      return {
        manga,
        chapters,
        current,
        pages,
        prev: readableIndex > 0 ? readable[readableIndex - 1] : undefined,
        next: readable[readableIndex + 1],
        initialPage: clampPage(state?.lastPage ?? 0, pages.length),
        cKey,
      };
    },
    [mangaKey, chapterId, sourceId, mangaId],
  );

  // Ignore data belonging to the previous chapter while useLoad catches up.
  const reader = data?.cKey === expectedKey ? data : undefined;

  // Revoke blob: URLs minted for downloaded pages when the chapter changes
  // or the reader unmounts, so object URLs do not leak.
  useEffect(() => {
    const urls = data?.pages;
    return () => {
      if (urls) revokeBlobUrls(urls);
    };
  }, [data]);

  const recordProgress = useCallback(
    (requestedPage: number, force = false, updateUI = true): void => {
      const session = sessionRef.current;
      if (!session || session.data.pages.length === 0) {
        return;
      }

      const currentData = session.data;
      const p = clampPage(requestedPage, currentData.pages.length);
      const atEnd = p >= currentData.pages.length - 1;
      const now = Date.now();

      if (atEnd && updateUI) {
        setFinished(true);
      }

      if (!force && !atEnd && now - lastProgressTimeRef.current < 400) {
        return;
      }
      lastProgressTimeRef.current = now;

      const savedMangaKey = session.mangaKey;
      const patch = atEnd
        ? { read: true, lastPage: p }
        : { lastPage: p };
      const history = {
        key: currentData.cKey,
        mangaKey: savedMangaKey,
        mangaTitle: currentData.manga.title,
        coverUrl: currentData.manga.coverUrl,
        chapterName: currentData.current.name,
        page: p,
        updatedAt: now,
      };

      // Serialize writes so an older save cannot overwrite final progress.
      writesRef.current = writesRef.current.then(async () => {
        try {
          await patchChapterState(currentData.cKey, savedMangaKey, patch);
        } catch (saveError: unknown) {
          console.error('Unable to save chapter progress', saveError);
        }

        try {
          await putHistory(history);
        } catch (saveError: unknown) {
          console.error('Unable to save reading history', saveError);
        }
      });
    },
    [],
  );

  useEffect(() => {
    initializedKeyRef.current = null;
    resumedRef.current = false;
    restoringRef.current = true;
    lastProgressTimeRef.current = -Infinity;
    pageRef.current = 0;

    setReadyKey(null);
    setPage(0);
    setFinished(false);
    setShowBar(true);

    if (screenRef.current) {
      screenRef.current.scrollTop = 0;
    }

    return () => {
      // This also runs before the same component receives a new chapter.
      recordProgress(pageRef.current, true, false);
      sessionRef.current = null;
    };
  }, [mangaKey, chapterId, recordProgress]);

  useEffect(() => {
    if (!reader || initializedKeyRef.current === reader.cKey) {
      return;
    }

    initializedKeyRef.current = reader.cKey;
    sessionRef.current = { data: reader, mangaKey };
    pageRef.current = reader.initialPage;
    lastProgressTimeRef.current = -Infinity;
    resumedRef.current = false;
    restoringRef.current = true;

    setPage(reader.initialPage);
    setFinished(false);
    setReadyKey(reader.cKey);
    recordProgress(reader.initialPage, true);
  }, [reader, mangaKey, chapterId, recordProgress]);

  useEffect(() => {
    if (
      mode !== 'vertical' ||
      !reader ||
      readyKey !== reader.cKey ||
      resumedRef.current ||
      !pagesRef.current
    ) {
      return;
    }

    restoringRef.current = true;
    let releaseFrame: number | undefined;

    const frame = window.requestAnimationFrame(() => {
      const screen = screenRef.current;
      const container = pagesRef.current;
      if (!screen || !container) {
        restoringRef.current = false;
        return;
      }

      if (pageRef.current > 0) {
        container
          .querySelectorAll<HTMLImageElement>('img')
          .item(pageRef.current)
          ?.scrollIntoView({ block: 'start', behavior: 'instant' });
      } else {
        screen.scrollTop = 0;
      }

      resumedRef.current = true;
      releaseFrame = window.requestAnimationFrame(() => {
        restoringRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (releaseFrame !== undefined) {
        window.cancelAnimationFrame(releaseFrame);
      }
      restoringRef.current = false;
    };
  }, [reader, readyKey, mode, chapterId]);

  useEffect(() => {
    if (mode !== 'paged' || !reader || readyKey !== reader.cKey) {
      return;
    }

    for (
      let index = page + 1;
      index <= page + 3 && index < reader.pages.length;
      index += 1
    ) {
      const url = reader.pages[index];
      if (url) {
        const image = new Image();
        image.src = url;
      }
    }
  }, [reader, readyKey, mode, page]);

  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    if (
      mode !== 'vertical' ||
      event.currentTarget !== screenRef.current ||
      restoringRef.current ||
      !reader ||
      sessionRef.current?.data.cKey !== reader.cKey
    ) {
      return;
    }

    // Scrolling hides the floating chrome.
    if (showBar) {
      setShowBar(false);
    }

    const images = pagesRef.current?.querySelectorAll<HTMLImageElement>('img');
    if (!images?.length) {
      return;
    }

    let currentPage = 0;
    const midpoint = window.innerHeight * 0.5;

    for (let index = 0; index < images.length; index += 1) {
      if (images.item(index).getBoundingClientRect().top <= midpoint) {
        currentPage = index;
      }
    }

    pageRef.current = currentPage;
    setPage(currentPage);
    recordProgress(currentPage);
  }

  // Tap zones for the webtoon (scrolling) mode — paged mode has its own
  // invisible zone buttons. Center toggles the chrome; left/right taps
  // page through the chapter by most of a viewport, Mihon-style. Taps on
  // actual controls (buttons, inputs, the chrome itself) are ignored.
  function handleTapZones(event: React.MouseEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, [data-chrome]')) {
      return;
    }

    const x = event.clientX / Math.max(1, window.innerWidth);

    if (x >= 0.35 && x <= 0.65) {
      toggleChrome();
      return;
    }

    setShowBar(false);

    if (mode === 'vertical') {
      const screen = screenRef.current;
      if (!screen) return;
      const delta = window.innerHeight * 0.8;
      screen.scrollBy({ top: x < 0.35 ? -delta : delta, behavior: 'smooth' });
    }
  }

  function seekToPage(index: number): void {
    if (!reader || reader.pages.length === 0) {
      return;
    }

    const target = clampPage(index, reader.pages.length);
    pageRef.current = target;
    setPage(target);
    setFinished(false);
    recordProgress(target, true);

    if (mode === 'vertical') {
      restoringRef.current = true;
      pagesRef.current
        ?.querySelectorAll<HTMLImageElement>('img')
        .item(target)
        ?.scrollIntoView({ block: 'start', behavior: 'instant' });
      window.requestAnimationFrame(() => {
        restoringRef.current = false;
      });
    }
  }

  function prevPage(): void {
    if (!reader || reader.pages.length === 0) {
      return;
    }

    setShowBar(false);

    const previous = clampPage(pageRef.current - 1, reader.pages.length);
    pageRef.current = previous;
    setPage(previous);
    setFinished(false);
    recordProgress(previous);
  }

  function nextPage(): void {
    if (!reader || reader.pages.length === 0) {
      return;
    }

    setShowBar(false);

    if (pageRef.current >= reader.pages.length - 1) {
      recordProgress(pageRef.current, true);
      setFinished(true);
      return;
    }

    const next = clampPage(pageRef.current + 1, reader.pages.length);
    pageRef.current = next;
    setPage(next);
    recordProgress(next);
  }

  function toggleMode(): void {
    const nextMode: ReaderMode = mode === 'vertical' ? 'paged' : 'vertical';
    if (nextMode === 'vertical') {
      resumedRef.current = false;
      restoringRef.current = true;
    }
    saveSettings({ readerMode: nextMode });
    setMode(nextMode);
  }

  function retry(): void {
    resumedRef.current = false;
    reload();
  }

  if (error && !loading) {
    return (
      <div
        className="screen--full"
        ref={screenRef}
        style={{ display: 'grid', placeItems: 'center', padding: 24 }}
      >
        <div style={{ maxWidth: 560, textAlign: 'center' }}>
          <p className="error" role="alert">
            {error}
          </p>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => nav.openManga(mangaKey)}
            >
              Back
            </button>
            <button type="button" className="btn" onClick={retry}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading || !reader || readyKey !== expectedKey) {
    return (
      <div
        className="screen--full"
        ref={screenRef}
        style={{ display: 'grid', placeItems: 'center' }}
      >
        <div className="spinner" role="status" aria-label="Loading chapter" />
      </div>
    );
  }

  const pageCount = reader.pages.length;
  const displayedPage = pageCount > 0 ? clampPage(page, pageCount) + 1 : 0;
  const progress = pageCount > 0 ? (displayedPage / pageCount) * 100 : 0;
  const chapterEnd = (
    <section
      aria-label="Chapter complete"
      style={{
        padding: '40px 20px calc(40px + env(safe-area-inset-bottom, 0px))',
        textAlign: 'center',
        maxWidth: 720,
        margin: '0 auto',
      }}
    >
      <h2>You finished {reader.current.name}</h2>
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: 12,
          marginTop: 24,
        }}
      >
        {reader.prev && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (reader.prev) {
                nav.openReader(mangaKey, reader.prev.id);
              }
            }}
          >
            Prev chapter
          </button>
        )}
        {reader.next && (
          <button
            type="button"
            className="btn"
            style={{ background: 'var(--accent, #7c3aed)', color: '#fff' }}
            onClick={() => {
              if (reader.next) {
                nav.openReader(mangaKey, reader.next.id);
              }
            }}
          >
            Next chapter
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => nav.openManga(mangaKey)}
        >
          Back to details
        </button>
      </div>
    </section>
  );

  return (
    <div
      className="screen--full"
      ref={screenRef}
      onScroll={handleScroll}
      onClick={handleTapZones}
      style={{
        overflow: 'auto',
        overscrollBehavior: 'contain',
        scrollBehavior: 'auto',
        ...(mode === 'paged' ? { background: '#000', color: '#fff' } : {}),
      }}
    >
      <div
        className="progress-line"
        role="progressbar"
        aria-label="Chapter progress"
        aria-valuemin={0}
        aria-valuemax={pageCount}
        aria-valuenow={displayedPage}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          zIndex: 102,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            background: 'var(--accent, #7c3aed)',
          }}
        />
      </div>

      {/* Floating chrome — overlays the pages, hidden while reading. */}
      <div
        data-chrome
        className="reader-chrome reader-chrome--top"
        style={{
          opacity: showBar ? 1 : 0,
          visibility: showBar ? 'visible' : 'hidden',
          pointerEvents: showBar ? 'auto' : 'none',
        }}
      >
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => nav.back()}
        >
          Back
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              opacity: 0.7,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {reader.manga.title}
          </div>
          <div
            style={{
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {reader.current.name}
          </div>
        </div>
      </div>

      {pageCount > 0 && (
        <div
          data-chrome
          className="reader-chrome reader-chrome--bottom"
          style={{
            opacity: showBar ? 1 : 0,
            visibility: showBar ? 'visible' : 'hidden',
            pointerEvents: showBar ? 'auto' : 'none',
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
              minWidth: 64,
            }}
          >
            {displayedPage} / {pageCount}
          </span>
          <input
            type="range"
            aria-label="Seek to page"
            min={1}
            max={pageCount}
            value={displayedPage}
            onChange={(event) => seekToPage(Number(event.target.value) - 1)}
            style={{ flex: 1, minWidth: 0, minHeight: 32 }}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={toggleMode}
            aria-label={`Switch to ${mode === 'vertical' ? 'paged' : 'vertical'} mode`}
            style={{ flexShrink: 0 }}
          >
            {mode === 'vertical' ? 'Vertical' : 'Paged'}
          </button>
        </div>
      )}

      {pageCount === 0 ? (
        <div
          className="empty"
          style={{
            padding: '120px 24px 40px',
            textAlign: 'center',
          }}
        >
          <p>No pages available for this chapter.</p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => nav.openManga(mangaKey)}
          >
            Back to details
          </button>
        </div>
      ) : mode === 'vertical' ? (
        <>
          <div className="reader-pages" ref={pagesRef}>
            {reader.pages.map((url, index) => (
              <img referrerPolicy="no-referrer"
                key={`${reader.cKey}:${index}`}
                src={url}
                loading={index < 2 ? 'eager' : 'lazy'}
                alt={`Page ${index + 1}`}
                style={{
                  display: 'block',
                  margin: '0 auto',
                  width: '100%',
                  maxWidth: '100%',
                  height: 'auto',
                }}
              />
            ))}
          </div>
          {chapterEnd}
        </>
      ) : finished ? (
        <div
          style={{
            minHeight: '100%',
            display: 'grid',
            alignItems: 'center',
            boxSizing: 'border-box',
          }}
        >
          {chapterEnd}
        </div>
      ) : (
        <>
          {/* Paged mode: fit to width, centered vertically via margin
              auto; pages taller than the viewport extend naturally and
              the reader surface scrolls. */}
          <div
            style={{
              minHeight: '100%',
              display: 'flex',
              background: '#000',
            }}
          >
            <img referrerPolicy="no-referrer"
              key={`${reader.cKey}:${page}`}
              src={reader.pages[page]}
              alt={`Page ${page + 1}`}
              loading="eager"
              style={{
                display: 'block',
                width: '100%',
                height: 'auto',
                margin: 'auto',
              }}
            />
          </div>
          <button
            type="button"
            aria-label="Previous page"
            onClick={prevPage}
            style={{
              position: 'fixed',
              inset: '0 auto 0 0',
              width: '30%',
              zIndex: 60,
              border: 0,
              padding: 0,
              background: 'transparent',
              cursor: 'pointer',
              touchAction: 'manipulation',
            }}
          />
          <button
            type="button"
            aria-label={showBar ? 'Hide reader controls' : 'Show reader controls'}
            aria-pressed={showBar}
            onClick={toggleChrome}
            style={{
              position: 'fixed',
              inset: '0 auto 0 30%',
              width: '40%',
              zIndex: 60,
              border: 0,
              padding: 0,
              background: 'transparent',
              cursor: 'pointer',
              touchAction: 'manipulation',
            }}
          />
          <button
            type="button"
            aria-label="Next page"
            onClick={nextPage}
            style={{
              position: 'fixed',
              inset: '0 0 0 70%',
              width: '30%',
              zIndex: 60,
              border: 0,
              padding: 0,
              background: 'transparent',
              cursor: 'pointer',
              touchAction: 'manipulation',
            }}
          />
        </>
      )}
    </div>
  );
}
