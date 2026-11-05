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
  type Source,
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

// One chapter's worth of pages inside the continuous webtoon flow.
interface FlowSegment {
  chapter: SChapter;
  cKey: string;
  pages: string[];
}

type FlowEnd = 'none' | 'end' | 'error';

// Downloads-aware page resolution shared by the chapter loader and the
// webtoon flow's chapter appending: a downloaded chapter is served 100%
// from Cache Storage (airplane mode); anything else goes to the source.
async function loadChapterPages(
  source: Source,
  sourceId: string,
  mangaId: string,
  chapterId: string,
): Promise<string[]> {
  const cKey = chapterKey(sourceId, mangaId, chapterId);
  const state = await getChapterState(cKey);
  const dl = state?.downloaded ? await getDownload(cKey) : undefined;
  if (dl && dl.pageCount > 0 && (await isChapterCached(cKey, dl.pageCount))) {
    return resolveChapterPages(
      cKey,
      new Array<string>(dl.pageCount).fill(''),
    );
  }
  return (await source.getPageList(chapterId)).map((entry) => entry.imageUrl);
}

function clampPage(value: number, count: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(normalized, Math.max(0, count - 1)));
}

// Clamp a zoomed page's edge position: when the scaled page is larger
// than the viewport it must always cover it (no void gaps); when smaller
// it stays centered on that axis.
function clampEdge(pos: number, size: number, view: number): number {
  if (size <= view) {
    return (view - size) / 2;
  }
  return Math.min(0, Math.max(view - size, pos));
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
  // Paged-mode zoom (Fix 2): scale 1 = fit-to-width (axis-locked). Zoom
  // state is per-chapter and resets on chapter/page/mode changes.
  const [zoomed, setZoomed] = useState(false);

  const zoomRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const pagedImgRef = useRef<HTMLImageElement>(null);
  const pendingTapRef = useRef<{ time: number; timer: number } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    totalX: number;
    totalY: number;
  } | null>(null);
  const suppressZoomClickRef = useRef(false);
  const lastZoomTapRef = useRef(0);

  // Continuous webtoon flow (Fix 3): chapters append below the anchor
  // chapter and the strip stays one strictly-vertical scroll. All flow
  // progress writes go through the same db helpers as the single-chapter
  // path (patchChapterState + putHistory) — no parallel store.
  const [segments, setSegments] = useState<FlowSegment[]>([]);
  const [activeSeg, setActiveSeg] = useState(0);
  const [flowEnd, setFlowEnd] = useState<FlowEnd>('none');
  const segmentsRef = useRef<FlowSegment[]>([]);
  const readerRef = useRef<ReaderData | null>(null);
  const mangaInfoRef = useRef<{ title: string; coverUrl: string }>({
    title: '',
    coverUrl: '',
  });
  const activeRef = useRef<{ index: number; cKey: string } | null>(null);
  const appendingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<ReaderMode>(mode);
  modeRef.current = mode;

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

  // --- Paged zoom (Fix 2) -------------------------------------------------
  // The transform is applied straight to the page <img> (origin 0 0) via
  // ref so panning does not re-render React on every pointer move.
  const applyZoom = useCallback((animate: boolean) => {
    const img = pagedImgRef.current;
    if (!img) {
      return;
    }
    const z = zoomRef.current;
    img.style.transition = animate ? 'transform 0.2s ease' : '';
    img.style.transform =
      z.scale > 1 ? `translate(${z.tx}px, ${z.ty}px) scale(${z.scale})` : '';
  }, []);

  const resetZoom = useCallback(() => {
    zoomRef.current = { scale: 1, tx: 0, ty: 0 };
    const img = pagedImgRef.current;
    if (img) {
      img.style.transition = '';
      img.style.transform = '';
    }
    panRef.current = null;
    setZoomed(false);
  }, []);

  function toggleZoomAt(clientX: number, clientY: number): void {
    if (zoomRef.current.scale > 1) {
      resetZoom();
      return;
    }

    const img = pagedImgRef.current;
    if (!img) {
      return;
    }

    const rect = img.getBoundingClientRect();
    const scale = 2;
    // Keep the tapped point fixed under the finger while scaling.
    let tx = (clientX - rect.left) * (1 - scale);
    let ty = (clientY - rect.top) * (1 - scale);
    // Then clamp so the scaled page covers the viewport (no void).
    const left = clampEdge(
      rect.left + tx,
      rect.width * scale,
      window.innerWidth,
    );
    const top = clampEdge(
      rect.top + ty,
      rect.height * scale,
      window.innerHeight,
    );
    tx += left - (rect.left + tx);
    ty += top - (rect.top + ty);

    zoomRef.current = { scale, tx, ty };
    setZoomed(true);
    setShowBar(false);
    applyZoom(true);
  }

  // Zone buttons route through here so a double-tap can be told apart
  // from two single taps: the single-tap action is held for ~300ms and
  // cancelled if a second tap lands (which zooms instead).
  function handleZoneTap(
    action: 'prev' | 'center' | 'next',
    event: React.MouseEvent,
  ): void {
    const now = performance.now();
    const pending = pendingTapRef.current;

    if (pending && now - pending.time < 300) {
      window.clearTimeout(pending.timer);
      pendingTapRef.current = null;
      toggleZoomAt(event.clientX, event.clientY);
      return;
    }

    const timer = window.setTimeout(() => {
      pendingTapRef.current = null;
      if (action === 'prev') {
        prevPage();
      } else if (action === 'next') {
        nextPage();
      } else {
        toggleChrome();
      }
    }, 300);
    pendingTapRef.current = { time: now, timer };
  }

  function handleZoomPointerDown(
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    if (zoomRef.current.scale <= 1) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      totalX: 0,
      totalY: 0,
    };
    const img = pagedImgRef.current;
    if (img) {
      img.style.transition = '';
    }
  }

  function handleZoomPointerMove(
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    const pan = panRef.current;
    const img = pagedImgRef.current;
    if (!pan || pan.pointerId !== event.pointerId || !img) {
      return;
    }

    const dx = event.clientX - pan.lastX;
    const dy = event.clientY - pan.lastY;
    pan.lastX = event.clientX;
    pan.lastY = event.clientY;
    pan.totalX += dx;
    pan.totalY += dy;

    // Clamp against the page's current (scaled) on-screen rect so it
    // can never be dragged into the void.
    const rect = img.getBoundingClientRect();
    const z = zoomRef.current;
    const newLeft = clampEdge(rect.left + dx, rect.width, window.innerWidth);
    const newTop = clampEdge(rect.top + dy, rect.height, window.innerHeight);
    z.tx += newLeft - rect.left;
    z.ty += newTop - rect.top;
    applyZoom(false);
  }

  function handleZoomPointerEnd(
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    if (Math.abs(pan.totalX) + Math.abs(pan.totalY) > 8) {
      // The pointerup's click must not count toward a double-tap reset.
      suppressZoomClickRef.current = true;
    }
    panRef.current = null;
  }

  function handleZoomLayerClick(event: React.MouseEvent): void {
    event.stopPropagation();
    if (suppressZoomClickRef.current) {
      suppressZoomClickRef.current = false;
      return;
    }
    // Single tap while zoomed does nothing (Mihon-like); a double-tap
    // returns to fit width, which re-engages the axis lock.
    const now = performance.now();
    if (now - lastZoomTapRef.current < 300) {
      lastZoomTapRef.current = 0;
      resetZoom();
    } else {
      lastZoomTapRef.current = now;
    }
  }

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  // Progress writer for any chapter inside the webtoon flow. Mirrors
  // recordProgress semantics: reaching the last page marks the chapter
  // read; writes are serialized through the same promise chain and every
  // save also lands in history (so crossing into a chapter records its
  // history entry exactly like opening it directly).
  const flowRecord = useCallback(
    (segment: FlowSegment, requestedPage: number, force = false): void => {
      if (segment.pages.length === 0) {
        return;
      }

      const p = clampPage(requestedPage, segment.pages.length);
      const atEnd = p >= segment.pages.length - 1;
      const now = Date.now();

      if (!force && !atEnd && now - lastProgressTimeRef.current < 400) {
        return;
      }
      lastProgressTimeRef.current = now;

      const patch = atEnd ? { read: true, lastPage: p } : { lastPage: p };
      const history = {
        key: segment.cKey,
        mangaKey,
        mangaTitle: mangaInfoRef.current.title,
        coverUrl: mangaInfoRef.current.coverUrl,
        chapterName: segment.chapter.name,
        page: p,
        updatedAt: now,
      };

      writesRef.current = writesRef.current.then(async () => {
        try {
          await patchChapterState(segment.cKey, mangaKey, patch);
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
    [mangaKey],
  );

  const flowRecordRef = useRef(flowRecord);
  useEffect(() => {
    flowRecordRef.current = flowRecord;
  }, [flowRecord]);

  // Append the next readable chapter (external chapters are skipped
  // entirely) below the loaded strip. Guarded against concurrent calls
  // and duplicates; a chapter that fails or has no pages surfaces the
  // retry card instead of spinning forever.
  const tryAppendNextChapter = useCallback(async (): Promise<void> => {
    if (appendingRef.current) {
      return;
    }

    const data = readerRef.current;
    const segs = segmentsRef.current;
    if (!data || segs.length === 0) {
      return;
    }

    const readable = data.chapters.filter((chapter) => !chapter.external);
    const last = segs[segs.length - 1];
    const lastIndex = last
      ? readable.findIndex((chapter) => chapter.id === last.chapter.id)
      : -1;
    const next = lastIndex >= 0 ? readable[lastIndex + 1] : undefined;

    if (!next) {
      setFlowEnd('end');
      return;
    }

    const source = getSource(sourceId);
    if (!source) {
      setFlowEnd('end');
      return;
    }

    appendingRef.current = true;
    try {
      const pages = await loadChapterPages(source, sourceId, mangaId, next.id);
      if (pages.length === 0) {
        throw new Error('Next chapter has no pages');
      }

      const segment: FlowSegment = {
        chapter: next,
        cKey: chapterKey(sourceId, mangaId, next.id),
        pages,
      };

      setSegments((prev) => {
        if (prev.some((entry) => entry.cKey === segment.cKey)) {
          return prev;
        }
        const updated = [...prev, segment];
        segmentsRef.current = updated;
        return updated;
      });
      setFlowEnd('none');
    } catch {
      setFlowEnd('error');
    } finally {
      appendingRef.current = false;
    }
  }, [sourceId, mangaId]);

  const tryAppendRef = useRef(tryAppendNextChapter);
  useEffect(() => {
    tryAppendRef.current = tryAppendNextChapter;
  }, [tryAppendNextChapter]);

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
      // Downloaded chapters resolve from Cache Storage inside the helper,
      // so a chapter reads end-to-end offline (airplane mode).
      const pages = await loadChapterPages(source, sourceId, mangaId, chapterId);
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

    // Zoom is per-chapter: a new chapter always starts at fit width.
    resetZoom();
    if (pendingTapRef.current) {
      window.clearTimeout(pendingTapRef.current.timer);
      pendingTapRef.current = null;
    }

    // The webtoon flow restarts from the newly opened chapter (the
    // previous run's cleanup already flushed + revoked the old flow).
    segmentsRef.current = [];
    activeRef.current = null;
    appendingRef.current = false;
    readerRef.current = null;
    setSegments([]);
    setActiveSeg(0);
    setFlowEnd('none');

    setReadyKey(null);
    setPage(0);
    setFinished(false);
    setShowBar(true);

    if (screenRef.current) {
      screenRef.current.scrollTop = 0;
    }

    return () => {
      // This also runs before the same component receives a new chapter.
      // Flush progress for the chapter actually on screen: in webtoon
      // flow that is the active segment, not necessarily the anchor.
      const active = activeRef.current
        ? segmentsRef.current[activeRef.current.index]
        : undefined;
      if (modeRef.current === 'vertical' && active) {
        flowRecordRef.current(active, pageRef.current, true);
      } else {
        recordProgress(pageRef.current, true, false);
      }
      // Appended segments' blob URLs are revoked here; the anchor
      // chapter's pages are revoked by the [data] effect.
      for (const seg of segmentsRef.current.slice(1)) {
        revokeBlobUrls(seg.pages);
      }
      sessionRef.current = null;
    };
  }, [mangaKey, chapterId, recordProgress, resetZoom]);

  useEffect(() => {
    if (!reader || initializedKeyRef.current === reader.cKey) {
      return;
    }

    initializedKeyRef.current = reader.cKey;
    sessionRef.current = { data: reader, mangaKey };
    readerRef.current = reader;
    mangaInfoRef.current = {
      title: reader.manga.title,
      coverUrl: reader.manga.coverUrl,
    };

    // Seed the webtoon flow with the opened chapter as the anchor
    // segment; later chapters append below it as the user scrolls.
    if (modeRef.current === 'vertical') {
      const anchor: FlowSegment = {
        chapter: reader.current,
        cKey: reader.cKey,
        pages: reader.pages,
      };
      segmentsRef.current = [anchor];
      activeRef.current = { index: 0, cKey: reader.cKey };
      setSegments([anchor]);
      setActiveSeg(0);
      setFlowEnd('none');
    }

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

  // Webtoon flow: when the strip's end sentinel comes within ~1.5
  // viewports, append the next chapter so reading never hits a wall.
  useEffect(() => {
    if (mode !== 'vertical' || !reader || readyKey !== reader.cKey) {
      return;
    }

    const sentinel = sentinelRef.current;
    const root = screenRef.current;
    if (!sentinel || !root) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void tryAppendRef.current();
        }
      },
      {
        root,
        rootMargin: `0px 0px ${Math.round(window.innerHeight * 1.5)}px 0px`,
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [mode, reader, readyKey, segments, flowEnd]);

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

    const segs = segmentsRef.current;

    if (segs.length > 0 && pagesRef.current) {
      // Continuous flow: the active chapter is whichever segment holds
      // the viewport midpoint; page, progress, history and the chrome
      // all follow it.
      const containers =
        pagesRef.current.querySelectorAll<HTMLElement>('[data-segment]');

      if (containers.length === segs.length) {
        const midpoint = window.innerHeight * 0.5;
        let activeIndex = 0;

        containers.forEach((container, index) => {
          if (container.getBoundingClientRect().top <= midpoint) {
            activeIndex = index;
          }
        });

        const container = containers.item(activeIndex);
        const segment = segs[activeIndex];
        if (!container || !segment) {
          return;
        }

        let currentPage = 0;
        const images = container.querySelectorAll<HTMLImageElement>('img');
        for (let index = 0; index < images.length; index += 1) {
          if (images.item(index).getBoundingClientRect().top <= midpoint) {
            currentPage = index;
          }
        }

        const prevActive = activeRef.current;
        if (
          prevActive &&
          prevActive.cKey !== segment.cKey &&
          activeIndex > prevActive.index
        ) {
          // Crossing into a later chapter finishes the previous one,
          // exactly like reaching its end used to.
          const prevSegment = segs[prevActive.index];
          if (prevSegment) {
            flowRecord(prevSegment, prevSegment.pages.length - 1, true);
          }
        }
        if (!prevActive || prevActive.index !== activeIndex) {
          setActiveSeg(activeIndex);
        }
        activeRef.current = { index: activeIndex, cKey: segment.cKey };

        pageRef.current = currentPage;
        setPage(currentPage);
        flowRecord(segment, currentPage);

        // Proximity fallback for appending (the sentinel
        // IntersectionObserver below is the primary trigger).
        const el = event.currentTarget;
        if (
          el.scrollHeight - (el.scrollTop + el.clientHeight) <
          window.innerHeight * 1.5
        ) {
          void tryAppendRef.current();
        }
        return;
      }
    }

    // Fallback: single-chapter tracking before the flow initializes.
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
    if (
      target.closest('button, a, input, select, [data-chrome], [data-zoom-layer]')
    ) {
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

    resetZoom();

    if (mode === 'vertical' && segmentsRef.current.length > 0) {
      // In flow mode the slider seeks within the ACTIVE chapter.
      const segIndex = activeRef.current?.index ?? 0;
      const segment = segmentsRef.current[segIndex];
      if (!segment) {
        return;
      }

      const target = clampPage(index, segment.pages.length);
      pageRef.current = target;
      setPage(target);
      setFinished(false);
      flowRecord(segment, target, true);

      restoringRef.current = true;
      pagesRef.current
        ?.querySelectorAll<HTMLElement>('[data-segment]')
        .item(segIndex)
        ?.querySelectorAll<HTMLImageElement>('img')
        .item(target)
        ?.scrollIntoView({ block: 'start', behavior: 'instant' });
      window.requestAnimationFrame(() => {
        restoringRef.current = false;
      });
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

    resetZoom();
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

    resetZoom();
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
    resetZoom();

    // Leaving (or re-entering) the webtoon flow discards the appended
    // chapters; flush the on-screen chapter's progress first.
    const activeSegment = activeRef.current
      ? segmentsRef.current[activeRef.current.index]
      : undefined;
    if (mode === 'vertical' && activeSegment) {
      flowRecord(activeSegment, pageRef.current, true);
    }
    for (const seg of segmentsRef.current.slice(1)) {
      revokeBlobUrls(seg.pages);
    }
    segmentsRef.current = [];
    activeRef.current = null;
    setSegments([]);
    setFlowEnd('none');

    const nextMode: ReaderMode = mode === 'vertical' ? 'paged' : 'vertical';
    if (nextMode === 'vertical') {
      resumedRef.current = false;
      restoringRef.current = true;
      if (reader) {
        const anchor: FlowSegment = {
          chapter: reader.current,
          cKey: reader.cKey,
          pages: reader.pages,
        };
        segmentsRef.current = [anchor];
        activeRef.current = { index: 0, cKey: reader.cKey };
        setSegments([anchor]);
        setActiveSeg(0);
        pageRef.current = reader.initialPage;
        setPage(reader.initialPage);
      }
    } else if (reader) {
      // Paged mode is anchored to the opened chapter; restart it at its
      // saved page rather than wherever the flow had scrolled to.
      pageRef.current = reader.initialPage;
      setPage(reader.initialPage);
      setFinished(false);
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

  // In webtoon flow the chrome counts pages of the ACTIVE chapter; in
  // paged mode it counts the opened chapter, as before. Before the flow
  // state seeds, the strip falls back to just the opened chapter.
  const displaySegments: FlowSegment[] =
    mode === 'vertical'
      ? segments.length > 0 && segments[0]?.cKey === reader.cKey
        ? segments
        : [
            {
              chapter: reader.current,
              cKey: reader.cKey,
              pages: reader.pages,
            },
          ]
      : [];
  const activeSegment =
    mode === 'vertical'
      ? displaySegments[
          Math.min(activeSeg, Math.max(0, displaySegments.length - 1))
        ]
      : undefined;
  const pageCount = activeSegment
    ? activeSegment.pages.length
    : reader.pages.length;
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
        // Overflow axes, overscroll and touch-action live in .screen--full
        // (axis-locked: overflow-x hidden, pan-y only). Inline overflow here
        // would override the lock, so it is set only while paged-zoomed.
        scrollBehavior: 'auto',
        ...(mode === 'paged' ? { background: '#000', color: '#fff' } : {}),
        // While zoomed the page is panned by transform, not by scroll.
        ...(zoomed ? { overflow: 'hidden' } : {}),
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
            {activeSegment ? activeSegment.chapter.name : reader.current.name}
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
        <div className="reader-pages" ref={pagesRef}>
          {displaySegments.map((segment, segIndex) => (
            <div key={segment.cKey} data-segment={segIndex}>
              {segIndex > 0 && (
                <div className="chapter-divider">{segment.chapter.name}</div>
              )}
              {segment.pages.map((url, index) => (
                <img referrerPolicy="no-referrer"
                  key={`${segment.cKey}:${index}`}
                  src={url}
                  loading={segIndex === 0 && index < 2 ? 'eager' : 'lazy'}
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
          ))}
          {flowEnd === 'end' && (
            <section
              aria-label="End of the latest chapter"
              style={{
                padding:
                  '40px 20px calc(40px + env(safe-area-inset-bottom, 0px))',
                textAlign: 'center',
                maxWidth: 720,
                margin: '0 auto',
              }}
            >
              <h2>You're at the latest chapter</h2>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  gap: 12,
                  marginTop: 24,
                }}
              >
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => nav.openManga(mangaKey)}
                >
                  Back to details
                </button>
              </div>
            </section>
          )}
          {flowEnd === 'error' && (
            <section
              aria-label="Next chapter failed to load"
              style={{
                padding:
                  '40px 20px calc(40px + env(safe-area-inset-bottom, 0px))',
                textAlign: 'center',
                maxWidth: 720,
                margin: '0 auto',
              }}
            >
              <h2>Couldn't load the next chapter</h2>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  gap: 12,
                  marginTop: 24,
                }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setFlowEnd('none');
                    void tryAppendNextChapter();
                  }}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => nav.openManga(mangaKey)}
                >
                  Back to details
                </button>
              </div>
            </section>
          )}
          <div ref={sentinelRef} style={{ height: 1 }} />
        </div>
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
              ref={pagedImgRef}
              key={`${reader.cKey}:${page}`}
              src={reader.pages[page]}
              alt={`Page ${page + 1}`}
              loading="eager"
              style={{
                display: 'block',
                width: '100%',
                maxWidth: '100%',
                height: 'auto',
                margin: 'auto',
                // Zoom transform (Fix 2) is applied via ref with a
                // top-left origin; fit width is the untransformed state.
                transformOrigin: '0 0',
              }}
            />
          </div>
          {!zoomed && (
            <>
              <button
                type="button"
                aria-label="Previous page"
                onClick={(event) => handleZoneTap('prev', event)}
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
                onClick={(event) => handleZoneTap('center', event)}
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
                onClick={(event) => handleZoneTap('next', event)}
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
          {zoomed && (
            <div
              data-zoom-layer
              onClick={handleZoomLayerClick}
              onPointerDown={handleZoomPointerDown}
              onPointerMove={handleZoomPointerMove}
              onPointerUp={handleZoomPointerEnd}
              onPointerCancel={handleZoomPointerEnd}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 60,
                background: 'transparent',
                cursor: 'grab',
                // The layer owns every gesture while zoomed so native
                // scrolling can never fight the transform pan.
                touchAction: 'none',
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
