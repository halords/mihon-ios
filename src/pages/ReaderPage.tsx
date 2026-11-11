import { useCallback, useEffect, useRef, useState } from 'react';
import { getChapterState, patchChapterState, patchManga, saveReadingProgress } from '../lib/db';
import { getCachedPageList, maybeAutoDeleteReadChapter, PAGES_CACHE, revokeBlobUrls } from '../lib/downloads';
import { loadMangaData } from '../lib/mangaData';
import { useNav } from '../lib/nav';
import { useOnline, useSettings } from '../lib/hooks';
import { saveSettings, type ReaderMode } from '../lib/settings';
import { chapterKey, splitMangaKey, type SChapter, type SManga, type MangaPage } from '../sources/Source';
import { getSource } from '../sources';
import { fetchImage } from '../lib/fetchJson';
import Icon from '../components/Icon';
import Sheet from '../components/Sheet';
import { toast } from '../components/Feedback';

interface Segment { chapter: SChapter; key: string; pages: MangaPage[] }
interface ReaderData { manga: SManga; chapters: SChapter[]; anchor: Segment; initialPage: number; offset: number; mode: ReaderMode }
interface Position { segment: Segment; page: number; offset: number; read: boolean }

export async function loadReaderPages(mangaKey: string, chapterId: string, signal?: AbortSignal): Promise<MangaPage[]> {
  const [sourceId, mangaId] = splitMangaKey(mangaKey);
  const key = chapterKey(sourceId, mangaId, chapterId);
  const cached = await getCachedPageList(key);
  if (cached) return cached;
  if (navigator.onLine === false) throw new Error('This chapter is not downloaded on this device. Reconnect and download it for offline reading.');
  const source = getSource(sourceId);
  if (!source) throw new Error('Connect this title’s source in Connections, or migrate it to an available source.');
  const pages = await source.getPageList(chapterId, mangaId, signal);
  if (!pages.length) throw new Error('The source returned no pages for this chapter');
  return pages;
}
function PageImage({ page, index, eager, paged, fit, onLoad }: { page: MangaPage; index: number; eager?: boolean; paged?: boolean; fit?: 'width' | 'screen'; onLoad: () => void }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const needsDecode = page.imageUrl.includes('#tiles=');
  const [src, setSrc] = useState(page.cachedKey || needsDecode ? '' : page.imageUrl);
  const [size, setSize] = useState({ width: page.width ?? 800, height: page.height ?? 1200 });
  const element = useRef<HTMLDivElement>(null);
  // Heat reduction (2026-11-11): plain remote pages join the blob-managed
  // pages in near-viewport recycling. Blob pages already unload when far
  // (object URL revoked in the effect above); remote pages used to keep
  // their <img> — and its decoded bitmap — alive for the whole session,
  // which grows without bound as webtoon mode chains chapters. Now the
  // <img> unmounts once the page is far from the viewport and the
  // container's aspect ratio holds its exact place in the strip.
  const blobManaged = !!(page.cachedKey || needsDecode);
  const [near, setNear] = useState(!!eager);
  useEffect(() => {
    if (paged || blobManaged) return;
    const el = element.current; if (!el) return;
    const observer = new IntersectionObserver(entries => { setNear(entries.some(e => e.isIntersecting)); }, { root: el.closest('.reader-screen'), rootMargin: '1000px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [paged, blobManaged]);
  useEffect(() => {
    if (!page.cachedKey && !needsDecode) return;
    let alive = true;
    let objectUrl = '';
    let request = 0;
    let controller: AbortController | undefined;
    async function activate(visible: boolean) {
      const token = ++request;
      if (!visible) { controller?.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = ''; setSrc(''); return; }
      if (objectUrl) return;
      try {
        controller?.abort(); controller = new AbortController();
        let blob: Blob;
        if (page.cachedKey) {
          const response = await (await caches.open(PAGES_CACHE)).match(page.cachedKey);
          if (!response) throw new Error('Downloaded page is missing');
          blob = await response.blob();
        } else blob = await fetchImage(page.imageUrl, controller.signal);
        if (!alive || token !== request) return;
        objectUrl = URL.createObjectURL(blob); setSrc(objectUrl);
      } catch { if (alive && token === request) setFailed(true); }
    }
    // Decoded images and blob URLs are held only near the visible pages.
    const observer = new IntersectionObserver(entries => { void activate(paged || entries.some(e => e.isIntersecting) || !!eager && !page.width); }, { root: element.current?.closest('.reader-screen'), rootMargin: '1000px 0px' });
    if (element.current) observer.observe(element.current);
    if (paged) void activate(true);
    return () => { alive = false; request++; controller?.abort(); observer.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [page.cachedKey, page.imageUrl, page.width, needsDecode, paged, eager, attempt]);
  const showImage = !!src && (blobManaged || near || !!eager);
  return <div ref={element} className={`reader-page ${paged ? `paged-page fit-${fit}` : ''}`} data-page={index} style={!paged ? { aspectRatio: `${size.width} / ${size.height}` } : undefined}>
    {failed ? <div className="page-error"><Icon name="cloud" size={30} /><p>Page {index + 1} could not load</p><button className="btn" onClick={event => { event.stopPropagation(); setFailed(false); setAttempt(a => a + 1); }}>Retry page</button></div> :
      showImage ? <img key={attempt} src={src} alt={`Page ${index + 1}`} width={size.width} height={size.height} loading={eager || paged ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer" draggable={false} onLoad={event => { const img = event.currentTarget; setSize({ width: img.naturalWidth, height: img.naturalHeight }); requestAnimationFrame(onLoad); }} onError={() => setFailed(true)} /> : <div className="page-placeholder" aria-label={`Loading page ${index + 1}`} />}
  </div>;
}

export default function ReaderPage({ mangaKey, chapterId }: { mangaKey: string; chapterId: string }) {
  const nav = useNav();
  const settings = useSettings();
  const online = useOnline();
  const [sourceId, mangaId] = splitMangaKey(mangaKey);
  const [reader, setReader] = useState<ReaderData | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<ReaderMode>(settings.readerMode);
  const [controls, setControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [bookmark, setBookmark] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [appendError, setAppendError] = useState('');
  const [appending, setAppending] = useState(false);
  const [zoom, setZoom] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const segmentsRef = useRef<Segment[]>([]);
  const readerRef = useRef<ReaderData | null>(null);
  const position = useRef<Position | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const generation = useRef(0);
  const restoring = useRef(false);
  const resumeTarget = useRef({ page: 0, offset: 0 });
  const pendingAppend = useRef(false);
  const writeChain = useRef(Promise.resolve());
  const lastSave = useRef(0);
  const durationStart = useRef(Date.now());
  const tap = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const active = segments[activeIndex] ?? reader?.anchor;
  const count = active?.pages.length ?? 0;

  const flush = useCallback((force = false) => {
    const current = position.current;
    const data = readerRef.current;
    if (!current || !data) return;
    const now = Date.now();
    if (!force && now - lastSave.current < 350) return;
    lastSave.current = now;
    const duration = document.hidden ? 0 : Math.max(0, Math.min(30000, now - durationStart.current));
    durationStart.current = now;
    const history = { key: current.segment.key, mangaKey, mangaTitle: data.manga.title, coverUrl: data.manga.coverUrl,
      chapterName: current.segment.chapter.name, page: current.page, updatedAt: now, readDuration: duration };
    writeChain.current = writeChain.current
      .then(() => saveReadingProgress(history, current.read, current.offset))
      .catch(() => toast('Unable to save reading progress. Check device storage.'))
      .then(() => { if (current.read) return maybeAutoDeleteReadChapter(mangaKey, current.segment.key).catch(() => {}); });
  }, [mangaKey]);
  const restorePosition = useCallback(() => {
    if (!restoring.current || !root.current || !strip.current) return;
    const pages = strip.current.querySelectorAll<HTMLElement>('[data-segment="0"] [data-page]');
    const target = pages[resumeTarget.current.page];
    if (!target) return;
    root.current.scrollTop += target.getBoundingClientRect().top - root.current.getBoundingClientRect().top + target.clientHeight * resumeTarget.current.offset;
    const sizesKnown = readerRef.current?.anchor.pages.slice(0, resumeTarget.current.page + 1).every(p => p.width && p.height);
    if (sizesKnown || [...pages].slice(0, resumeTarget.current.page + 1).every(node => { const img = node.querySelector('img'); return img?.complete && img.naturalWidth > 0; })) restoring.current = false;
  }, []);

  useEffect(() => {
    const id = ++generation.current;
    const abort = new AbortController();
    let alive = true;
    setReader(null); setError(''); setSegments([]); setActiveIndex(0); setAppendError(''); setAtEnd(false); setZoom(false); setControls(true);
    readerRef.current = null; position.current = null; segmentsRef.current = []; pendingAppend.current = false;
    durationStart.current = Date.now();
    let anchorUrls: string[] = [];
    void (async () => {
      const data = await loadMangaData(mangaKey);
      const chapter = data.chapters.find(c => c.id === chapterId);
      if (!chapter) throw new Error('This chapter is not in the saved chapter list. Refresh the title while online.');
      const pages = await loadReaderPages(mangaKey, chapterId, abort.signal);
      anchorUrls = pages.map(p => p.imageUrl);
      if (!alive || generation.current !== id) { revokeBlobUrls(anchorUrls); return; }
      const saved = await getChapterState(chapterKey(sourceId, mangaId, chapterId));
      if (!alive) { revokeBlobUrls(anchorUrls); return; }
      const initialPage = Math.max(0, Math.min(saved?.lastPage ?? 0, pages.length - 1));
      const anchor = { chapter, key: chapterKey(sourceId, mangaId, chapterId), pages };
      const excluded = Array.isArray(data.stored.mihon?.excludedScanlators) ? data.stored.mihon.excludedScanlators as string[] : [];
      const result: ReaderData = { manga: data.manga, chapters: data.chapters.filter(c => !c.external && (!excluded.includes(c.scanlator ?? '') || c.id === chapterId)),
        anchor, initialPage, offset: saved?.pageOffset ?? 0, mode: data.stored.readerMode ?? settings.readerMode };
      readerRef.current = result; segmentsRef.current = [anchor];
      position.current = { segment: anchor, page: initialPage, offset: result.offset, read: !!saved?.read };
      resumeTarget.current = { page: initialPage, offset: result.offset };
      restoring.current = result.mode === 'vertical' && (initialPage > 0 || result.offset > 0);
      setMode(result.mode); setPage(initialPage); setBookmark(!!saved?.bookmark); setSegments([anchor]); setReader(result);
      flush(true);
    })().catch(error => { if (alive && !abort.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to load chapter'); });
    const restoreTimeout = setTimeout(() => { restoring.current = false; }, 7000);
    return () => {
      alive = false; abort.abort(); generation.current++; clearTimeout(restoreTimeout); clearTimeout(tap.current);
      flush(true);
      for (const segment of segmentsRef.current) revokeBlobUrls(segment.pages.map(p => p.imageUrl));
      revokeBlobUrls(anchorUrls);
    };
  }, [mangaKey, chapterId, attempt, flush]);

  useEffect(() => {
    const save = () => flush(true);
    const visibility = () => { save(); durationStart.current = Date.now(); };
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', visibility);
    const heartbeat = setInterval(save, 15000);
    return () => { clearInterval(heartbeat); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', visibility); };
  }, [flush]);
  useEffect(() => {
    if (!controls || showSettings) return;
    const timer = setTimeout(() => setControls(false), 3500);
    return () => clearTimeout(timer);
  }, [controls, showSettings, reader?.anchor.key]);
  useEffect(() => { if (active) void getChapterState(active.key).then(s => setBookmark(!!s?.bookmark)); }, [active?.key]);

  const updateVisible = useCallback(() => {
    if (modeRef.current !== 'vertical' || !root.current || !strip.current || restoring.current) return;
    const viewport = root.current.getBoundingClientRect();
    const containers = strip.current.querySelectorAll<HTMLElement>('[data-segment]');
    let segIndex = 0;
    let visiblePage = 0;
    let offset = 0;
    let complete = false;
    for (let s = 0; s < containers.length; s++) {
      const container = containers[s]!;
      const rect = container.getBoundingClientRect();
      if (rect.top > viewport.top + viewport.height * 0.45) break;
      if (rect.bottom < viewport.top) continue;
      segIndex = s;
      const pages = container.querySelectorAll<HTMLElement>('[data-page]');
      for (let p = 0; p < pages.length; p++) {
        const pageRect = pages[p]!.getBoundingClientRect();
        if (pageRect.top <= viewport.top + viewport.height * 0.35) {
          visiblePage = p;
          offset = Math.max(0, Math.min(1, (viewport.top - pageRect.top) / Math.max(1, pageRect.height)));
        }
      }
      const last = pages[pages.length - 1];
      const image = last?.querySelector('img');
      complete = !!image?.complete && image.naturalWidth > 0 && (last?.getBoundingClientRect().bottom ?? Infinity) <= viewport.bottom + 12;
      if (complete) visiblePage = Math.max(0, pages.length - 1);
      break;
    }
    const segment = segmentsRef.current[segIndex];
    if (!segment) return;
    const old = position.current;
    if (old && old.segment.key !== segment.key) flush(true);
    position.current = { segment, page: visiblePage, offset, read: complete || (old?.segment.key === segment.key && old.read) || false };
    setActiveIndex(segIndex); setPage(visiblePage); flush();
  }, [flush]);

  const appendNext = useCallback(async () => {
    const data = readerRef.current;
    const current = segmentsRef.current;
    if (!data || !current.length || pendingAppend.current) return;
    const index = data.chapters.findIndex(c => c.id === current[current.length - 1]!.chapter.id);
    const next = data.chapters[index + 1];
    if (!next) return;
    pendingAppend.current = true; setAppending(true); setAppendError('');
    const id = generation.current;
    try {
      const pages = await loadReaderPages(mangaKey, next.id);
      if (generation.current !== id) { revokeBlobUrls(pages.map(p => p.imageUrl)); return; }
      const segment = { chapter: next, key: chapterKey(sourceId, mangaId, next.id), pages };
      const updated = [...segmentsRef.current, segment];
      segmentsRef.current = updated; setSegments(updated);
    } catch (error) { if (generation.current === id) setAppendError(error instanceof Error ? error.message : 'Unable to load the next chapter'); }
    finally { if (generation.current === id) { pendingAppend.current = false; setAppending(false); } }
  }, [mangaKey, sourceId, mangaId]);
  useEffect(() => {
    if (mode !== 'vertical' || !reader || !settings.continuousReading || !sentinel.current || !root.current || appendError) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) void appendNext(); }, { root: root.current, rootMargin: '0px 0px 650px 0px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [mode, reader, segments.length, settings.continuousReading, appendNext, appendError]);
  useEffect(() => {
    if (!reader || mode !== 'vertical') return;
    requestAnimationFrame(restorePosition);
    const timer = setTimeout(() => { restoring.current = false; updateVisible(); }, 5000);
    return () => clearTimeout(timer);
  }, [reader, mode, restorePosition, updateVisible]);

  function seek(value: number): void {
    if (!active) return;
    const index = Math.max(0, Math.min(value, active.pages.length - 1));
    restoring.current = false; setZoom(false); setAtEnd(false); setPage(index);
    position.current = { segment: active, page: index, offset: 0, read: position.current?.segment.key === active.key && position.current.read || false };
    flush(true);
    if (mode === 'vertical') strip.current?.querySelector(`[data-segment="${activeIndex}"] [data-page="${index}"]`)?.scrollIntoView({ block: 'start', behavior: 'instant' });
    else root.current?.scrollTo(0, 0);
  }
  function nextPage(delta: number): void {
    if (!active) return;
    if (mode === 'vertical') { root.current?.scrollBy({ top: delta * (root.current.clientHeight * 0.8), behavior: 'smooth' }); return; }
    const currentPage = position.current?.page ?? page;
    const target = currentPage + delta;
    if (target >= active.pages.length) { if (position.current) position.current.read = true; flush(true); setAtEnd(true); setControls(true); }
    else if (target < 0) {
      const index = reader?.chapters.findIndex(c => c.id === active.chapter.id) ?? -1;
      const previous = reader?.chapters[index - 1];
      if (previous) { flush(true); nav.openReader(mangaKey, previous.id); }
    } else seek(target);
  }
  function zoneTap(delta: number, event: React.MouseEvent): void {
    event.stopPropagation();
    if (swallowClick.current) { swallowClick.current = false; return; }
    if (tap.current) { clearTimeout(tap.current); tap.current = undefined; setZoom(v => !v); setControls(false); return; }
    tap.current = setTimeout(() => { tap.current = undefined; if (delta === 0) setControls(v => !v); else nextPage(delta); }, 240);
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input, textarea, select, dialog') || event.key === ' ' && (event.target as HTMLElement)?.closest('button')) return;
      if (event.key === 'Escape') { nav.back(); return; }
      const delta = event.key === 'ArrowRight' ? mode === 'rtl' ? -1 : 1 : event.key === 'ArrowLeft' ? mode === 'rtl' ? 1 : -1 :
        [' ', 'ArrowDown', 'PageDown'].includes(event.key) ? 1 : ['ArrowUp', 'PageUp'].includes(event.key) ? -1 : 0;
      if (delta) { event.preventDefault(); nextPage(delta); }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [reader, page, mode, activeIndex]);

  async function chooseMode(next: ReaderMode): Promise<void> {
    flush(true); await writeChain.current;
    await patchManga(mangaKey, { readerMode: next });
    setShowSettings(false); setZoom(false);
    if (active && active.chapter.id !== chapterId) { nav.openReader(mangaKey, active.chapter.id); return; }
    if (next === 'vertical' && reader) {
      const anchor = reader.anchor;
      for (const segment of segmentsRef.current.slice(1)) revokeBlobUrls(segment.pages.map(p => p.imageUrl));
      segmentsRef.current = [anchor]; setSegments([anchor]); setActiveIndex(0);
      resumeTarget.current = { page, offset: 0 }; restoring.current = page > 0;
    }
    setMode(next); setAtEnd(false);
    if (next !== 'vertical') requestAnimationFrame(() => root.current?.scrollTo(0, 0));
  }
  function imageLoaded(): void {
    if (restoring.current) { restorePosition(); return; }
    if (modeRef.current === 'vertical') { requestAnimationFrame(updateVisible); return; }
    if (position.current && position.current.page === position.current.segment.pages.length - 1) { position.current.read = true; flush(true); }
  }
  if (error) return <div className="reader-fallback"><Icon name="cloud" size={42} /><h2>Unable to open chapter</h2><p role="alert">{error}</p><button className="btn" onClick={() => setAttempt(a => a + 1)}>Retry</button><button className="text-btn" onClick={() => nav.openManga(mangaKey)}>Back to title</button><button className="text-btn" onClick={nav.openConnections}>Connections</button></div>;
  if (!reader || !active) return <div className="reader-fallback"><div className="spinner" role="status" aria-label="Loading chapter" /><button className="text-btn" onClick={nav.back}>Back</button></div>;
  const chapterIndex = reader.chapters.findIndex(c => c.id === active.chapter.id);
  const previous = reader.chapters[chapterIndex - 1];
  const next = reader.chapters[chapterIndex + 1];
  return <div className={`reader-screen ${mode === 'vertical' ? 'reader-vertical' : 'reader-paged'} ${zoom ? 'reader-zoomed' : ''}`} ref={root} onScroll={() => requestAnimationFrame(updateVisible)} onClick={event => {
    if (event.target instanceof HTMLElement && event.target.closest('button, input, dialog, [data-chrome]')) return;
    if (mode === 'vertical' || zoom) setControls(v => !v);
  }}>
    <div className="reader-progress" aria-hidden="true"><span style={{ width: `${(page + 1) / Math.max(1, count) * 100}%` }} /></div>
    <div className={`reader-chrome reader-chrome--top ${controls ? 'visible' : ''}`} data-chrome>
      <button className="icon-btn" aria-label="Back" onClick={() => { flush(true); nav.back(); }}><Icon name="back" /></button><div className="reader-heading"><small>{reader.manga.title}</small><strong>{active.chapter.name}</strong></div>
      {!online && <span className="reader-offline">Offline</span>}<button className={`icon-btn ${bookmark ? 'accent' : ''}`} aria-label={bookmark ? 'Remove bookmark' : 'Bookmark chapter'} onClick={() => void patchChapterState(active.key, mangaKey, { bookmark: !bookmark }).then(() => setBookmark(v => !v)).catch(error => toast(String(error)))}><Icon name="bookmark" filled={bookmark} /></button>
    </div>
    {mode === 'vertical' ? <div className="reader-strip" ref={strip}>{segments.map((segment, index) => <section key={segment.key} data-segment={index} className="reader-segment">
      {index > 0 && <div className="chapter-divider">{segment.chapter.name}</div>}
      {segment.pages.map((asset, p) => <PageImage key={`${segment.key}:${p}`} page={asset} index={p} eager={index === 0 && p <= Math.max(2, resumeTarget.current.page)} onLoad={imageLoaded} />)}
    </section>)}<div ref={sentinel} className="reader-sentinel" />{appending && <div className="reader-bottom-note">Loading next chapter…</div>}{appendError && <div className="reader-bottom-note"><p>{appendError}</p><button className="btn" onClick={() => { setAppendError(''); void appendNext(); }}>Retry next chapter</button></div>}
      {!next && <div className="reader-end"><Icon name="check" size={36} /><h2>You’re caught up</h2><p>You’ve reached the latest saved chapter.</p><button className="btn" onClick={() => nav.openManga(mangaKey)}>Back to title</button></div>}
      {!settings.continuousReading && next && <div className="reader-end"><button className="btn" onClick={() => { flush(true); nav.openReader(mangaKey, next.id); }}>Next chapter <Icon name="arrow" /></button></div>}
    </div> : atEnd ? <div className="reader-end reader-end-full"><Icon name="check" size={40} /><h2>Chapter complete</h2><p>{active.chapter.name}</p>{next && <button className="btn" onClick={() => nav.openReader(mangaKey, next.id)}>Next chapter <Icon name="arrow" /></button>}<button className="text-btn" onClick={() => setAtEnd(false)}>Return to last page</button><button className="text-btn" onClick={() => nav.openManga(mangaKey)}>Back to title</button></div> : <>
      <div className="paged-stage" onDoubleClick={() => setZoom(v => !v)}><PageImage key={`${active.key}:${page}`} page={active.pages[page]!} index={page} eager paged fit={settings.readerFit} onLoad={imageLoaded} /></div>
      {!zoom && <div className="reader-tap-zones" onPointerDown={e => swipe.current = { x: e.clientX, y: e.clientY }} onPointerUp={e => {
        if (!swipe.current) return;
        const dx = e.clientX - swipe.current.x; const dy = e.clientY - swipe.current.y; swipe.current = null;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) { swallowClick.current = true; nextPage((dx < 0 ? 1 : -1) * (mode === 'rtl' ? -1 : 1)); }
      }} onPointerCancel={() => swipe.current = null}>
        <button aria-label={mode === 'rtl' ? 'Next page' : 'Previous page'} onClick={e => zoneTap(mode === 'rtl' ? 1 : -1, e)} />
        <button aria-label={controls ? 'Hide reader controls' : 'Show reader controls'} onClick={e => zoneTap(0, e)} />
        <button aria-label={mode === 'rtl' ? 'Previous page' : 'Next page'} onClick={e => zoneTap(mode === 'rtl' ? -1 : 1, e)} />
      </div>}
    </>}
    <div className={`reader-chrome reader-chrome--bottom ${controls ? 'visible' : ''}`} data-chrome>
      <div className="reader-slider"><span>{page + 1}</span><input type="range" min={1} max={count} value={page + 1} aria-label="Seek to page" onChange={e => seek(Number(e.target.value) - 1)} /><span>{count}</span></div>
      <div className="reader-tools"><button className="icon-btn" aria-label="Previous chapter" disabled={!previous} onClick={() => { flush(true); if (previous) nav.openReader(mangaKey, previous.id); }}><Icon name="back" /></button><button className="text-btn" onClick={() => setShowSettings(true)}><Icon name="settings" size={18} />{mode === 'vertical' ? 'Webtoon' : mode === 'rtl' ? 'Right to left' : 'Left to right'}</button><button className="icon-btn" aria-label="Next chapter" disabled={!next} onClick={() => { flush(true); if (next) nav.openReader(mangaKey, next.id); }}><Icon name="chevron" /></button></div>
    </div>
    <div className="reader-page-counter" aria-hidden="true" hidden={controls}>{page + 1} / {count}</div>
    {showSettings && <Sheet title="Reader settings" onClose={() => setShowSettings(false)}>
      <label className="form-row">Reading mode<select aria-label="Reading mode" value={mode} onChange={e => void chooseMode(e.target.value as ReaderMode)}><option value="vertical">Webtoon / continuous vertical</option><option value="paged">Left to right</option><option value="rtl">Right to left</option></select></label>
      <label className="form-row">Fit pages<select value={settings.readerFit} onChange={e => saveSettings({ readerFit: e.target.value as 'width' | 'screen' })}><option value="screen">Fit screen</option><option value="width">Fit width</option></select></label>
      <label className="form-row">Continue into next chapter<input type="checkbox" checked={settings.continuousReading} onChange={e => saveSettings({ continuousReading: e.target.checked })} /></label>
      <p className="muted">Tap the center to show controls. Swipe or use arrow keys in paged mode. Double tap to zoom.</p><button className="btn wide" onClick={() => setShowSettings(false)}>Done</button>
    </Sheet>}
  </div>;
}
