import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MangaGrid, MangaList, type MangaListItem } from '../components/MangaViews';
import Icon from '../components/Icon';
import Sheet from '../components/Sheet';
import Cover from '../components/Cover';
import { EmptyState, toast } from '../components/Feedback';
import { libraryCategories, patchChapterState, removeFromLibrary, setLibraryCategory } from '../lib/db';
import { getLibrarySnapshot, loadLibrary, setLibrarySnapshot, subscribeLibrarySnapshot } from '../lib/libraryData';
import { useNav } from '../lib/nav';
import { saveSettings } from '../lib/settings';
import { useSettings } from '../lib/hooks';
import { getSource } from '../sources';
import { enqueueChapters } from '../lib/downloadQueue';
import { compareLibraryItems, LIBRARY_SORT_OPTIONS } from '../lib/librarySort';
import LibrarySortControls from '../components/LibrarySortControls';
import FastScroller from '../components/FastScroller';

// The library view reads the session snapshot from ../lib/libraryData
// (assembled once per app load; patched live by the user's own actions —
// reading progress, opening a title, adding/removing a title — and never
// reshuffled by background sync). This hook only owns the full-reload
// path (refresh button, in-page actions) and its loading/error state.
function useLibraryData() {
  const data = useSyncExternalStore(subscribeLibrarySnapshot, getLibrarySnapshot);
  const [loading, setLoading] = useState(() => getLibrarySnapshot() === null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const reload = useCallback(() => {
    const current = ++run.current;
    setLoading(true);
    setError(null);
    loadLibrary().then(result => {
      if (run.current !== current) return;
      setLibrarySnapshot(result);
      setLoading(false);
    }).catch(cause => {
      if (run.current !== current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    });
  }, []);
  useEffect(() => { if (getLibrarySnapshot() === null) reload(); }, [reload]);
  return { data, loading, error, reload };
}

type Filter = 'all' | 'unread' | 'started' | 'completed' | 'bookmarked' | 'missing';

export default function LibraryPage() {
  const nav = useNav();
  const settings = useSettings();
  const { data, loading, error, reload } = useLibraryData();
  const [category, setCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [sheet, setSheet] = useState<'filters' | 'sort' | 'categories' | 'more' | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categorySelection, setCategorySelection] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const all = data?.items ?? [];
  const visible = all.filter(item => {
    if (category !== 'All' && !libraryCategories(item.entry).includes(category)) return false;
    if (settings.downloadedOnly && !item.downloaded) return false;
    if (query && ![item.stored.manga.title, item.stored.manga.author, item.stored.manga.sourceName, ...item.stored.manga.genres].join(' ').toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === 'unread' && !item.unread || filter === 'started' && !item.lastRead ||
      filter === 'completed' && (item.unread > 0 || !item.chapters.length) || filter === 'bookmarked' && !item.bookmarked ||
      filter === 'missing' && getSource(item.stored.manga.sourceId)) return false;
    return true;
  }).sort((a, b) => compareLibraryItems(a.sort, b.sort, settings));
  const cards: MangaListItem[] = visible.map(item => ({ key: item.entry.key, manga: item.stored.manga, unread: item.unread, total: item.chapters.length, downloaded: item.downloaded,
    sourceMissing: !['local', '0'].includes(item.stored.manga.sourceId) && !getSource(item.stored.manga.sourceId), selected: selecting ? selected.has(item.entry.key) : undefined }));
  function toggle(key: string): void { setSelecting(true); setSelected(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  function clearSelection(): void { setSelecting(false); setSelected(new Set()); }
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await action(); clearSelection(); setSheet(null); reload(); }
    catch (error) { toast(error instanceof Error ? error.message : 'Unable to update library'); }
    finally { setBusy(false); }
  }
  function openCategories(): void {
    const first = all.find(i => selected.has(i.entry.key));
    setCategorySelection(first ? libraryCategories(first.entry) : ['Default']);
    setSheet('categories');
  }
  return <main className="screen library-screen">
    <header className={`topbar ${selecting ? 'selection-topbar' : ''}`}>
      {selecting ? <><button className="icon-btn" aria-label="Cancel selection" onClick={clearSelection}><Icon name="close" /></button><h1>{selected.size} selected</h1><button className="icon-btn" aria-label="Select all visible titles" onClick={() => setSelected(new Set(visible.map(i => i.entry.key)))}><Icon name="check" /></button></> :
        <><h1>Library <span className="title-count">{all.length}</span></h1><button className={`icon-btn ${loading ? 'spinning' : ''}`} aria-label="Refresh library" aria-busy={loading} disabled={loading} onClick={reload}><Icon name="refresh" /></button><button className="icon-btn" aria-label="Search library" aria-pressed={showSearch} onClick={() => setShowSearch(!showSearch)}><Icon name="search" /></button><button className={`icon-btn ${filter !== 'all' || settings.downloadedOnly ? 'accent' : ''}`} aria-label="Filter and sort library" onClick={() => setSheet('filters')}><Icon name="filter" /></button><button className="icon-btn" aria-label="Library options" onClick={() => setSheet('more')}><Icon name="more" /></button></>}
    </header>
    {showSearch && <div className="searchbar"><Icon name="search" /><input type="search" autoFocus aria-label="Search your library" placeholder="Title, author, or source" value={query} onChange={e => setQuery(e.target.value)} /></div>}
    <div className="category-tabs" aria-label="Library categories">{['All', ...new Set((data?.categories ?? []).map(c => c.name))].map(name =>
      <button key={name} className={`category-tab ${category === name ? 'active' : ''}`} aria-pressed={category === name} onClick={() => setCategory(name)}>{name}<span>{name === 'All' ? all.length : all.filter(i => libraryCategories(i.entry).includes(name)).length}</span></button>)}</div>
    {settings.downloadedOnly && <div className="inline-note"><Icon name="download" size={16} /> Downloaded titles only<button className="text-btn" onClick={() => saveSettings({ downloadedOnly: false })}>Show all</button></div>}
    {!selecting && <div className="library-sort-bar"><span>{visible.length} titles</span><button className="text-btn" aria-label="Sort library" onClick={() => setSheet('sort')}><Icon name="sort" size={18} />{LIBRARY_SORT_OPTIONS.find(option => option.value === settings.librarySort)?.label}<span aria-hidden="true">{settings.librarySortDirection === 'descending' ? '↓' : '↑'}</span></button></div>}
    {!selecting && !query && category === 'All' && data?.resume && (!settings.downloadedOnly || data.downloaded.has(data.resume.key)) && <button className="continue-card" onClick={() => nav.openReader(data.resume!.mangaKey, data.resume!.key.slice(data.resume!.mangaKey.length + 2))}>
      <Cover url={data.resume.coverUrl} title={data.resume.mangaTitle} /><span><small>CONTINUE READING</small><strong>{data.resume.mangaTitle}</strong><span>{data.resume.chapterName} · Page {data.resume.page + 1}</span></span><span className="continue-play"><Icon name="play" size={20} filled /></span>
    </button>}
    {loading && !data ? <div className="spinner" role="status" aria-label="Loading library" /> : error ? <div className="error" role="alert">{error}<button className="text-btn" onClick={reload}>Retry</button></div> : !all.length ?
      <EmptyState title="Your library starts here"><p>Bring your Mihon library with you, or find your next read.</p><button className="btn" onClick={nav.openBackup}><Icon name="backup" size={18} />Import Mihon backup</button><button className="text-btn" onClick={() => nav.setTab('browse')}>Browse sources <Icon name="arrow" size={16} /></button></EmptyState> :
      !cards.length ? <EmptyState icon="search" title="No titles match"><p>Try another category or adjust your filters.</p><button className="text-btn" onClick={() => { setCategory('All'); setQuery(''); setFilter('all'); saveSettings({ downloadedOnly: false }); }}>Reset filters</button></EmptyState> :
      settings.libraryView === 'grid' ? <MangaGrid items={cards} onOpen={key => selecting ? toggle(key) : nav.openManga(key)} onMenu={toggle} /> : <MangaList items={cards} onOpen={key => selecting ? toggle(key) : nav.openManga(key)} onMenu={toggle} />}
    {selecting && <div className="selection-actions" aria-label="Selected title actions">
      <button className="icon-btn" disabled={!selected.size || busy} aria-label="Set categories" onClick={openCategories}><Icon name="folder" /></button>
      <button className="icon-btn" disabled={!selected.size || busy} aria-label="Download unread chapters" onClick={() => void run(async () => {
        let count = 0;
        for (const item of all.filter(i => selected.has(i.entry.key))) count += await enqueueChapters(item.entry.key, item.chapters.filter(c => !data?.state.get(c.key)?.read).map(c => c.chapter.id));
        toast(`${count} chapters added to the download queue`);
      })}><Icon name="download" /></button>
      <button className="icon-btn" disabled={!selected.size || busy} aria-label="Mark selected titles read" onClick={() => void run(async () => { for (const item of all.filter(i => selected.has(i.entry.key))) for (const c of item.chapters) await patchChapterState(c.key, item.entry.key, { read: true }); toast('Marked as read'); })}><Icon name="check" /></button>
      <button className="icon-btn" disabled={!selected.size || busy} aria-label="Remove selected titles from library" onClick={() => {
        if (window.confirm(`Remove ${selected.size} titles and their downloaded files? Reading history and progress are kept.`)) void run(async () => { for (const key of selected) await removeFromLibrary(key); });
      }}><Icon name="trash" /></button>
    </div>}
    {sheet === 'filters' && <Sheet title="Library options" onClose={() => setSheet(null)}>
      <div className="form-row"><span>Downloaded only</span><input type="checkbox" aria-label="Downloaded only" checked={settings.downloadedOnly} onChange={e => saveSettings({ downloadedOnly: e.target.checked })} /></div>
      <label className="form-row">Reading status<select value={filter} onChange={e => setFilter(e.target.value as Filter)}><option value="all">All titles</option><option value="unread">Has unread chapters</option><option value="started">Started reading</option><option value="completed">All chapters read</option><option value="bookmarked">Has bookmarks</option><option value="missing">Needs a source</option></select></label>
      <LibrarySortControls />
      <label className="form-row">Display<select value={settings.libraryView} onChange={e => saveSettings({ libraryView: e.target.value as 'grid' | 'list' })}><option value="grid">Cover grid</option><option value="list">List</option></select></label><button className="btn wide" onClick={() => setSheet(null)}>Done</button>
    </Sheet>}
    {sheet === 'sort' && <Sheet title="Sort library" onClose={() => setSheet(null)}><LibrarySortControls /><button className="btn wide" onClick={() => setSheet(null)}>Done</button></Sheet>}
    {sheet === 'more' && <Sheet title="Library" onClose={() => setSheet(null)}>
      <button className="sheet-option" onClick={() => { setSheet(null); setSelecting(true); }}><Icon name="check" />Select titles</button>
      <button className="sheet-option" onClick={nav.openCategories}><Icon name="folder" />Manage categories</button>
      <button className="sheet-option" onClick={nav.openBackup}><Icon name="backup" />Backup & restore</button>
      <button className="sheet-option" onClick={nav.openDownloads}><Icon name="download" />Download manager</button>
    </Sheet>}
    {sheet === 'categories' && <Sheet title="Set categories" onClose={() => setSheet(null)}>
      {(data?.categories ?? []).map(c => <label key={c.id} className="form-row"><span>{c.name}</span><input type="checkbox" checked={categorySelection.includes(c.name)} onChange={e => setCategorySelection(old => e.target.checked ? [...old, c.name] : old.filter(n => n !== c.name))} /></label>)}
      <button className="btn wide" disabled={busy} onClick={() => void run(async () => { for (const key of selected) await setLibraryCategory(key, categorySelection); })}>Apply to {selected.size} titles</button>
    </Sheet>}
    {!loading && data && <FastScroller hidden={sheet !== null} />}
  </main>;
}
