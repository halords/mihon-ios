import { useEffect, useRef, useState } from 'react';
import { addToLibrary, getCategories, libraryCategories, patchChapterState, patchManga, removeFromLibrary, setLibraryCategory } from '../lib/db';
import { useNav } from '../lib/nav';
import { emitLibraryLive } from '../lib/libraryLive';
import { useLoad } from '../lib/useLoad';
import { useDataEvents, useOnline } from '../lib/hooks';
import { loadMangaData } from '../lib/mangaData';
import { chapterKey, splitMangaKey, type SChapter } from '../sources/Source';
import { getSource } from '../sources';
import { enqueueChapters } from '../lib/downloadQueue';
import { deleteMangaDownloads, deleteChapterDownload } from '../lib/downloads';
import ChapterRow from '../components/ChapterRow';
import Cover from '../components/Cover';
import Icon from '../components/Icon';
import SourceLogo from '../components/SourceLogo';
import Sheet from '../components/Sheet';
import FastScroller from '../components/FastScroller';
import { EmptyState, toast } from '../components/Feedback';
import type { ParsedTracking } from '../backup/models';

type ChapterFilter = 'all' | 'unread' | 'read' | 'downloaded' | 'bookmarked';
export default function MangaDetailsPage({ mangaKey }: { mangaKey: string }) {
  const nav = useNav();
  const online = useOnline();
  const [sourceId, mangaId] = splitMangaKey(mangaKey);
  const { data, loading, error, reload } = useLoad(() => loadMangaData(mangaKey), [mangaKey]);
  useDataEvents(reload);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [sheet, setSheet] = useState<'categories' | 'downloads' | 'filter' | 'chapter' | 'selection' | null>(null);
  const [categories, setCategories] = useState<Awaited<ReturnType<typeof getCategories>>>([]);
  const [categoryDraft, setCategoryDraft] = useState<string[]>([]);
  const [chapterFilter, setChapterFilter] = useState<ChapterFilter>('all');
  const [newestFirst, setNewestFirst] = useState(true);
  const [showExcluded, setShowExcluded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const selectionAnchor = useRef<string | null>(null);
  const [activeChapter, setActiveChapter] = useState<SChapter | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');
  function clearSelection(): void { setSelected(new Set()); setSelecting(false); selectionAnchor.current = null; }
  useEffect(() => { void getCategories().then(setCategories); }, [sheet]);
  useEffect(() => { if (data) setNotes(data.stored.notes ?? ''); }, [data?.stored.notes]);
  useEffect(() => { setExpanded(false); clearSelection(); setSheet(null); setNotice(''); }, [mangaKey]);
  const header = <header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>{data?.manga.title ?? 'Manga'}</h1><button className="icon-btn" aria-label="Refresh manga" disabled={refreshing || !online || !getSource(sourceId)} onClick={() => void refresh()}><Icon name="refresh" /></button></header>;
  async function refresh(): Promise<void> {
    setRefreshing(true); setNotice('');
    try { const fresh = await loadMangaData(mangaKey, true); setNotice(fresh.networkError ?? ''); reload(); if (!fresh.networkError) toast('Chapters refreshed'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to refresh'); }
    finally { setRefreshing(false); }
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try { await action(); setSheet(null); clearSelection(); reload(); }
    catch (error) { toast(error instanceof Error ? error.message : 'Unable to update this title'); }
    finally { setBusy(false); }
  }
  function toggleChapter(id: string): void {
    if (busy) return;
    setSelecting(true);
    if (!selectionAnchor.current) selectionAnchor.current = id;
    else if (selected.has(id) && selectionAnchor.current === id) selectionAnchor.current = [...selected].find(key => key !== id) ?? null;
    setSelected(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  if (loading && !data) return <main className="screen">{header}<div className="spinner" role="status" aria-label="Loading manga" /></main>;
  if (error || !data) return <main className="screen">{header}<div className="error" role="alert">{error ?? 'Manga could not be loaded'}<button className="text-btn" onClick={reload}>Retry</button></div></main>;
  const { manga, chapters, stateByKey, entry, sourceAvailable } = data;
  const sourceName = getSource(sourceId)?.name ?? manga.sourceName ?? (sourceId === 'local' || sourceId === '0' ? 'Local files' : sourceId);
  const exclusions = Array.isArray(data.stored.mihon?.excludedScanlators) ? data.stored.mihon.excludedScanlators as string[] : [];
  const readable = chapters.filter(c => !c.external && (showExcluded || !exclusions.includes(c.scanlator ?? '')));
  const unread = readable.filter(c => !stateByKey[chapterKey(sourceId, mangaId, c.id)]?.read);
  const downloaded = readable.filter(c => stateByKey[chapterKey(sourceId, mangaId, c.id)]?.downloaded);
  const latest = data.history.find(h => !stateByKey[h.key]?.read && readable.some(c => chapterKey(sourceId, mangaId, c.id) === h.key));
  let target = latest ? readable.find(c => chapterKey(sourceId, mangaId, c.id) === latest.key) : unread[0] ?? readable[0];
  if (!online) target = target && stateByKey[chapterKey(sourceId, mangaId, target.id)]?.downloaded ? target : downloaded.find(c => !stateByKey[chapterKey(sourceId, mangaId, c.id)]?.read) ?? downloaded[0];
  const canRead = !!target && (!!stateByKey[chapterKey(sourceId, mangaId, target.id)]?.downloaded || sourceAvailable && online);
  const visible = chapters.filter(c => {
    const state = stateByKey[chapterKey(sourceId, mangaId, c.id)];
    if (!showExcluded && exclusions.includes(c.scanlator ?? '')) return false;
    return chapterFilter === 'all' || chapterFilter === 'unread' && !state?.read || chapterFilter === 'read' && !!state?.read || chapterFilter === 'downloaded' && !!state?.downloaded || chapterFilter === 'bookmarked' && !!state?.bookmark;
  });
  if (newestFirst) visible.reverse();
  function selectRange(id: string): void {
    if (busy) return;
    const end = visible.findIndex(chapter => chapter.id === id);
    if (end < 0) return;
    const anchor = visible.findIndex(chapter => chapter.id === selectionAnchor.current);
    const start = anchor < 0 ? end : anchor;
    const range = visible.slice(Math.min(start, end), Math.max(start, end) + 1);
    setSelected(old => new Set([...old, ...range.map(chapter => chapter.id)]));
    selectionAnchor.current = id;
    setSelecting(true);
  }
  function selectAllVisible(): void {
    setSelected(new Set(visible.map(chapter => chapter.id)));
    selectionAnchor.current = visible[0]?.id ?? null;
    setSelecting(true);
    setSheet(null);
  }
  function markSelection(read: boolean): void {
    const ids = [...selected];
    if (!ids.length) return;
    void run(async () => {
      for (const id of ids) await patchChapterState(chapterKey(sourceId, mangaId, id), mangaKey, read ? { read: true } : { read: false, lastPage: 0 });
      toast(`${ids.length} ${ids.length === 1 ? 'chapter' : 'chapters'} marked as ${read ? 'read' : 'unread'}`);
    });
  }
  function downloadSelection(): void {
    const ids = [...selected];
    if (!ids.length) return;
    void run(async () => {
      const count = await enqueueChapters(mangaKey, ids);
      toast(count ? `${count} ${count === 1 ? 'chapter' : 'chapters'} added to the download queue` : 'Selected chapters are already downloaded or queued');
    });
  }
  const trackers = Array.isArray(data.stored.mihon?.tracking) ? data.stored.mihon.tracking as unknown as ParsedTracking[] : [];
  const readLabel = latest ? 'Continue reading' : unread.length && unread.length < readable.length ? 'Continue reading' : unread.length ? 'Start reading' : 'Read again';
  const actionKeys = selected.size ? [...selected] : activeChapter ? [activeChapter.id] : [];
  const website = sourceId === 'mangadex' ? `https://mangadex.org/title/${mangaId}` : /^https?:\/\//.test(manga.url ?? mangaId) ? manga.url ?? mangaId : getSource(sourceId)?.baseUrl ? new URL(manga.url ?? mangaId, getSource(sourceId)!.baseUrl).href : undefined;
  return <main className={`screen details-screen ${selecting ? 'chapter-selecting' : ''}`}>{header}
    <div className="manga-hero"><Cover url={manga.coverUrl} title={manga.title} /><div><h2>{manga.title}</h2><p>{[...new Set([manga.author, manga.artist].filter(Boolean))].join(' · ')}</p><div className="manga-status"><span className="status-dot" />{manga.status}</div><span className="manga-source source-caption"><SourceLogo id={sourceId} name={sourceName} iconUrl={getSource(sourceId)?.iconUrl} />{sourceName}</span></div></div>
    <div className="detail-actions">
      <button className={`detail-action ${entry ? 'accent' : ''}`} disabled={busy} onClick={() => {
        if (entry) { setCategoryDraft(libraryCategories(entry)); setSheet('categories'); }
        else void run(async () => { await addToLibrary(mangaKey, ['Default']); emitLibraryLive({ type: 'library-added', mangaKey }); toast('Added to library'); });
      }}><Icon name="heart" filled={!!entry} /><span>{entry ? 'In library' : 'Add to library'}</span></button>
      <button className="detail-action" onClick={() => setSheet('downloads')} disabled={!sourceAvailable}><Icon name="download" /><span>Download</span></button>
      <button className="detail-action" onClick={() => website && window.open(website, '_blank', 'noopener,noreferrer')} disabled={!website}><Icon name="browse" /><span>Web view</span></button>
      <button className="detail-action" onClick={() => nav.openMigration(mangaKey)}><Icon name="migrate" /><span>Migrate</span></button>
    </div>
    {readable.length > 0 && <button className="btn read-button" disabled={!canRead} onClick={() => target && nav.openReader(mangaKey, target.id)}><Icon name="play" size={19} filled /><span>{canRead ? readLabel : online ? 'Connect a source to read' : 'No downloaded chapters'}<small>{target?.name}{latest && target ? ` · Page ${(stateByKey[chapterKey(sourceId, mangaId, target.id)]?.lastPage ?? 0) + 1}` : ''}</small></span></button>}
    {!!downloaded.length && <div className="inline-note"><Icon name="check" size={16} />{downloaded.length} chapters available offline<button className="text-btn" onClick={nav.openDownloads}>Manage</button></div>}
    {!sourceAvailable && sourceId !== 'local' && <div className="source-notice"><Icon name="cloud" /><div><strong>{sourceId === '0' ? 'Local files need to be copied separately' : 'Your library is restored. Connect this source to read.'}</strong><p>{sourceId === '0' ? 'A Mihon backup contains progress and metadata. Import your chapter CBZ files to read offline.' : 'Connect Suwayomi to use the Android extension, or migrate to another available source.'}</p><button className="text-btn" onClick={nav.openConnections}>Connect source <Icon name="arrow" size={16} /></button></div></div>}
    {(notice || data.networkError) && <div className="inline-error" role="alert">{notice || data.networkError} Saved chapters are still available.{getSource(sourceId)?.kind === "builtin" && sourceId !== "mangadex" && <a className="text-btn" href={"#/connections?source=" + sourceId}>Browser verification</a>}</div>}
    {manga.description && <div className="description"><p className={expanded ? '' : 'clamped'}>{manga.description}</p><button className="text-btn" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Read more'}</button></div>}
    {!!manga.genres.length && <div className="genre-tags">{manga.genres.map(genre => <span className="chip" key={genre}>{genre}</span>)}</div>}
    <details className="notes-section"><summary>Notes{notes ? ' · saved' : ''}</summary><textarea aria-label="Manga notes" placeholder="Your notes about this title" value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => void patchManga(mangaKey, { notes }).catch(error => toast(String(error)))} /></details>
    {!!trackers.length && <details className="notes-section"><summary>Imported tracking · {trackers.length}</summary>{trackers.map((track, i) => <div className="tracker-row" key={i}><strong>{track.title || `Tracker ${track.syncId}`}</strong><span>Chapter {track.lastChapterRead}{track.totalChapters ? ` / ${track.totalChapters}` : ''} · Score {track.score}</span>{/^https?:\/\//.test(track.trackingUrl) && <a href={track.trackingUrl} target="_blank" rel="noopener noreferrer">View tracking entry</a>}</div>)}</details>}
    <section className="chapter-section" aria-label="Chapters">
      <div className="section-heading"><h3>{selecting ? `${selected.size} selected` : `${chapters.length} chapters`}</h3><span className="chapter-unread-count" aria-label={`${unread.length} unread chapters`}><span className="unread-dot" aria-hidden="true" />{unread.length}</span>{selecting ? <><button className="icon-btn" aria-label="Select all visible chapters" disabled={busy} onClick={selectAllVisible}><Icon name="check" /></button><button className="icon-btn" aria-label="Selected chapter actions" disabled={!selected.size || busy} onClick={() => setSheet('selection')}><Icon name="more" /></button><button className="icon-btn" aria-label="Clear chapter selection" disabled={busy} onClick={clearSelection}><Icon name="close" /></button></> : <><button className="icon-btn" aria-label="Select chapters" onClick={() => setSelecting(true)}><Icon name="check" /></button><button className="icon-btn" aria-label="Sort chapters" onClick={() => setNewestFirst(!newestFirst)}><Icon name="list" /></button><button className={`icon-btn ${chapterFilter !== 'all' ? 'accent' : ''}`} aria-label="Filter chapters" onClick={() => setSheet('filter')}><Icon name="filter" /></button></>}</div>
      {!!visible.length && <p className="chapter-selection-hint">{selecting ? 'Hold another chapter to select the range. Tap to adjust.' : 'Long-press a chapter to select.'}</p>}
      {!visible.length ? <EmptyState icon="library" title={chapters.length ? 'No chapters match' : 'No chapters saved yet'}><p>{chapters.length ? 'Adjust the chapter filter to see more.' : online && sourceAvailable ? 'Refresh this title to check its source.' : 'Connect a source when online to retrieve the chapter list.'}</p>{online && sourceAvailable && <button className="text-btn" onClick={() => void refresh()}>Refresh chapters</button>}</EmptyState> : visible.map(chapter => {
        const key = chapterKey(sourceId, mangaId, chapter.id);
        const state = stateByKey[key];
        return <ChapterRow key={key} chapter={chapter} state={state} mangaKey={mangaKey} sourceId={sourceId} mangaId={mangaId} sourceAvailable={sourceAvailable} online={online} selecting={selecting} selected={selected.has(chapter.id)} busy={busy} onToggle={() => toggleChapter(chapter.id)} onRange={() => selectRange(chapter.id)} onOpen={() => {
            if (chapter.external) window.open(chapter.externalUrl ?? (sourceId === 'mangadex' ? `https://mangadex.org/chapter/${chapter.id}` : new URL(chapter.url ?? chapter.id, getSource(sourceId)?.baseUrl).href), '_blank', 'noopener,noreferrer');
            else nav.openReader(mangaKey, chapter.id);
          }} onOptions={() => { setActiveChapter(chapter); setSheet('chapter'); }} />;
      })}
    </section>
    {!selecting && !sheet && target && canRead && <button className="chapter-play-fab" aria-label={`${readLabel}: ${target.name}`} onClick={() => nav.openReader(mangaKey, target.id)}><Icon name="play" size={24} filled /></button>}
    {selecting && <div className="chapter-selection-actions" role="toolbar" aria-label="Selected chapter actions" aria-busy={busy}>
      <span className="chapter-selection-count" aria-live="polite" aria-atomic="true"><span className="sr-only">Selected chapters: </span>{selected.size}</span>
      <button className="chapter-mark-read" disabled={!selected.size || busy} aria-label="Mark selected chapters as read" onClick={() => markSelection(true)}><Icon name="check" size={19} />Read</button>
      <button className="chapter-mark-unread" disabled={!selected.size || busy} aria-label="Mark selected chapters as unread" onClick={() => markSelection(false)}><Icon name="library" size={18} />Unread</button>
      <button className="chapter-mark-download" disabled={!selected.size || busy || !sourceAvailable} aria-label="Download selected chapters" onClick={downloadSelection}><Icon name="download" size={18} />Download</button>
      <button className="icon-btn" disabled={busy} aria-label="Cancel chapter selection" onClick={clearSelection}><Icon name="close" size={18} /></button>
    </div>}
    {sheet === 'categories' && <Sheet title="Library categories" onClose={() => setSheet(null)}>{categories.map(c => <label className="form-row" key={c.id}>{c.name}<input type="checkbox" checked={categoryDraft.includes(c.name)} onChange={e => setCategoryDraft(old => e.target.checked ? [...old, c.name] : old.filter(n => n !== c.name))} /></label>)}<button className="btn wide" disabled={busy} onClick={() => void run(() => setLibraryCategory(mangaKey, categoryDraft))}>Save categories</button><button className="text-btn danger" disabled={busy} onClick={() => { if (window.confirm('Remove this title and its downloaded files? Reading history and progress are kept.')) void run(async () => { await removeFromLibrary(mangaKey); emitLibraryLive({ type: 'library-removed', mangaKey }); }); }}>Remove from library</button></Sheet>}
    {sheet === 'downloads' && <Sheet title="Download chapters" onClose={() => setSheet(null)}>{[{ label: 'Next 5 unread chapters', list: unread.slice(0, 5) }, { label: 'Next 10 unread chapters', list: unread.slice(0, 10) }, { label: 'All unread chapters', list: unread }, { label: 'All chapters', list: readable }].map(option => <button className="sheet-option" key={option.label} disabled={busy || !option.list.length} onClick={() => void run(async () => { const count = await enqueueChapters(mangaKey, option.list.map(c => c.id)); toast(`${count} chapters added to the download queue`); })}><Icon name="download" />{option.label}<span>{option.list.length}</span></button>)}<button className="sheet-option" onClick={nav.openDownloads}><Icon name="list" />Open download manager</button>{downloaded.length > 0 && <button className="sheet-option danger" disabled={busy} onClick={() => { if (window.confirm('Delete every downloaded chapter for this title?')) void run(() => deleteMangaDownloads(mangaKey)); }}><Icon name="trash" />Delete downloaded chapters</button>}</Sheet>}
    {sheet === 'filter' && <Sheet title="Chapter list" onClose={() => setSheet(null)}><label className="form-row">Show<select value={chapterFilter} onChange={e => setChapterFilter(e.target.value as ChapterFilter)}><option value="all">All chapters</option><option value="unread">Unread</option><option value="read">Read</option><option value="downloaded">Downloaded</option><option value="bookmarked">Bookmarked</option></select></label><label className="form-row">Newest first<input type="checkbox" checked={newestFirst} onChange={e => setNewestFirst(e.target.checked)} /></label>{!!exclusions.length && <label className="form-row">Show excluded scanlators<input type="checkbox" checked={showExcluded} onChange={e => setShowExcluded(e.target.checked)} /></label>}<button className="sheet-option" onClick={selectAllVisible}><Icon name="check" />Select visible chapters</button><button className="btn wide" onClick={() => setSheet(null)}>Done</button></Sheet>}
    {(sheet === 'chapter' || sheet === 'selection') && <Sheet title={selected.size ? `${selected.size} chapters` : activeChapter?.name ?? 'Chapter'} onClose={() => setSheet(null)}>
      {sheet === 'chapter' && activeChapter && <button className="sheet-option" onClick={() => { selectRange(activeChapter.id); setSheet(null); }}><Icon name="check" />Select chapter</button>}
      {[{ label: 'Mark as read', patch: { read: true } }, { label: 'Mark as unread', patch: { read: false, lastPage: 0 } }, { label: 'Bookmark', patch: { bookmark: true } }, { label: 'Remove bookmark', patch: { bookmark: false } }].map(action => <button className="sheet-option" key={action.label} disabled={busy} onClick={() => void run(async () => { for (const id of actionKeys) await patchChapterState(chapterKey(sourceId, mangaId, id), mangaKey, action.patch); })}><Icon name={action.label.includes('ookmark') ? 'bookmark' : 'check'} />{action.label}</button>)}
      <button className="sheet-option" disabled={busy || !sourceAvailable} onClick={() => void run(async () => { const count = await enqueueChapters(mangaKey, actionKeys); toast(`${count} chapters queued`); })}><Icon name="download" />Download</button>
      <button className="sheet-option danger" disabled={busy} onClick={() => { if (window.confirm('Delete the downloaded pages for these chapters?')) void run(async () => { for (const id of actionKeys) await deleteChapterDownload(mangaKey, chapterKey(sourceId, mangaId, id)); }); }}><Icon name="trash" />Delete download</button>
    </Sheet>}
    <FastScroller bottomOffset="calc(env(safe-area-inset-bottom, 0px) + 88px)" hidden={sheet !== null} />
  </main>;
}
