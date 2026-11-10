import { useCallback, useEffect, useRef, useState } from 'react';
import { MangaGrid, MangaList } from '../components/MangaViews';
import Icon from '../components/Icon';
import Sheet from '../components/Sheet';
import { EmptyState } from '../components/Feedback';
import { loadBrowseState, saveBrowseState } from '../lib/browseState';
import { addToLibrary, getAllManga, getCategories, getLibrary, libraryCategories, putManga, removeFromLibrary, setLibraryCategory } from '../lib/db';
import { useDataEvents, useOnline, useSettings, useSources } from '../lib/hooks';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import { mangaKey, type SManga, type Source } from '../sources/Source';
import { ExtensionPanels } from './ExtensionsPage';

interface Group { id: string; name: string; items: SManga[]; page: number; loading: boolean; exhausted: boolean; error?: string }
export default function BrowsePage() {
  const nav = useNav();
  const online = useOnline();
  const settings = useSettings();
  const sources = useSources();
  const [initial] = useState(loadBrowseState);
  const [panel, setPanel] = useState<'titles' | 'sources' | 'extensions'>(initial ? 'titles' : 'sources');
  const [sourceQuery, setSourceQuery] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('all');
  const [sourceId, setSourceId] = useState(initial?.sourceId ?? 'mangadex');
  const [mode, setMode] = useState<'popular' | 'latest'>(initial?.mode ?? 'popular');
  const [query, setQuery] = useState(initial?.query ?? '');
  const [search, setSearch] = useState(initial?.query ?? '');
  const [groups, setGroups] = useState<Group[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [menuKey, setMenuKey] = useState('');
  const [categoryDraft, setCategoryDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [menuError, setMenuError] = useState('');
  const generation = useRef(0);
  const restore = useRef(initial);
  const scrollY = useRef(initial?.scrollY ?? 0);
  const latest = useRef({ query: search, mode, sourceId, items: [] as SManga[], pages: {} as Record<string, number>, exhausted: {} as Record<string, boolean>, scrollY: 0 });
  const { data, reload } = useLoad(async () => {
    const [library, categories, manga] = await Promise.all([getLibrary(), getCategories(), getAllManga()]);
    const keys = new Set(library.map(m => m.key));
    const imported = new Map<string, { id: string; name: string; count: number }>();
    for (const m of manga.filter(m => keys.has(m.key))) {
      const entry = imported.get(m.manga.sourceId) ?? { id: m.manga.sourceId, name: m.manga.sourceName ?? m.manga.sourceId, count: 0 };
      entry.count++; imported.set(entry.id, entry);
    }
    return { library, categories, imported: [...imported.values()] };
  }, []);
  useDataEvents(reload);
  const sourceStamp = sources.map(s => s.id + ':' + s.kind).join('|');
  const library = new Map(data?.library.map(entry => [entry.key, entry]) ?? []);
  const menuItem = groups.flatMap(g => g.items).find(m => mangaKey(m.sourceId, m.id) === menuKey);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const loadSource = useCallback(async (source: Source, page: number, token: number) => {
    setGroups(old => old.map(g => g.id === source.id ? { ...g, loading: true, error: undefined } : g));
    try {
      if (navigator.onLine === false) throw new Error('Reconnect to browse this source. Your saved library and downloads are available offline.');
      const items = search ? await source.searchManga(search, page) : mode === 'latest' ? await source.getLatestUpdates(page) : await source.getPopularManga(page);
      if (generation.current !== token) return;
      await Promise.all(items.map(m => putManga(m, true)));
      if (generation.current !== token) return;
      setGroups(old => old.map(g => {
        if (g.id !== source.id) return g;
        const combined = page === 1 ? items : [...g.items, ...items];
        return { ...g, items: [...new Map(combined.map(m => [m.id, m])).values()], page, loading: false, exhausted: !items.length || page > 1 && items.every(m => g.items.some(old => old.id === m.id)), error: undefined };
      }));
    } catch (error) {
      if (generation.current === token) setGroups(old => old.map(g => g.id === source.id ? { ...g, loading: false, error: error instanceof Error ? error.message : 'Source unavailable' } : g));
    }
  }, [search, mode]);

  useEffect(() => {
    const token = ++generation.current;
    if (panel !== 'titles') return;
    const targets = sourceId === 'all' ? sources : sources.filter(s => s.id === sourceId);
    const saved = restore.current;
    restore.current = null;
    if (saved && saved.query === search && saved.mode === mode && (saved.sourceId ?? 'mangadex') === sourceId && saved.items.length && attempt === 0) {
      setGroups(targets.map(source => ({ id: source.id, name: source.name, items: saved.items.filter(m => m.sourceId === source.id), page: saved.pages?.[source.id] ?? 1, loading: false, exhausted: saved.exhausted?.[source.id] ?? false })));
      requestAnimationFrame(() => window.scrollTo(0, saved.scrollY));
      return;
    }
    scrollY.current = 0;
    setGroups(targets.map(s => ({ id: s.id, name: s.name, items: [], page: 0, loading: true, exhausted: false })));
    // A failing source does not cancel other sources; limit parallel requests.
    void (async () => {
      for (let i = 0; i < targets.length && generation.current === token; i += 4) await Promise.allSettled(targets.slice(i, i + 4).map(source => loadSource(source, 1, token)));
    })();
    return () => { generation.current++; };
  }, [panel, sourceId, mode, search, sourceStamp, attempt, loadSource]);

  useEffect(() => {
    latest.current = { query: search, mode, sourceId, items: groups.flatMap(g => g.items), pages: Object.fromEntries(groups.map(g => [g.id, g.page])), exhausted: Object.fromEntries(groups.map(g => [g.id, g.exhausted])), scrollY: scrollY.current };
    if (groups.length) saveBrowseState(latest.current);
  }, [groups, search, mode, sourceId]);
  useEffect(() => {
    const persist = () => { scrollY.current = window.scrollY; saveBrowseState({ ...latest.current, scrollY: scrollY.current }); };
    window.addEventListener('scroll', persist, { passive: true });
    return () => { window.removeEventListener('scroll', persist); persist(); };
  }, []);

  function openMenu(key: string) {
    setMenuKey(key); setMenuError('');
    const entry = library.get(key);
    setCategoryDraft(entry ? libraryCategories(entry) : ['Default']);
  }
  async function menuAction(action: () => Promise<void>) {
    setBusy(true); setMenuError('');
    try { await action(); reload(); setMenuKey(''); }
    catch (error) { setMenuError(error instanceof Error ? error.message : 'Unable to update library'); }
    finally { setBusy(false); }
  }
  return <main className="screen">
    <header className="topbar"><h1>Browse</h1>{panel === 'titles' && <button className="icon-btn" aria-label="Refresh browse results" disabled={!online || groups.some(g => g.loading)} onClick={() => setAttempt(v => v + 1)}><Icon name="refresh" /></button>}<button className="icon-btn" aria-label="Connect more sources" onClick={nav.openConnections}><Icon name="cloud" /></button></header>
    <div className="seg" aria-label="Browse sections"><button aria-pressed={panel === 'sources'} onClick={() => setPanel('sources')}>Sources <span>{sources.length}</span></button><button aria-pressed={panel === 'extensions'} onClick={() => setPanel('extensions')}>Extensions</button><button aria-pressed={panel === 'titles'} onClick={() => setPanel('titles')}>Titles</button></div>
    {panel === 'extensions' && <ExtensionPanels />}
    {panel === 'sources' && <>
      <div className="searchbar"><Icon name="search" /><input type="search" aria-label="Search sources" placeholder="Find a source" value={sourceQuery} onChange={e => setSourceQuery(e.target.value)} /></div>
      <div className="browse-toolbar"><select aria-label="Source language" value={sourceLanguage} onChange={e => setSourceLanguage(e.target.value)}><option value="all">All languages</option>{[...new Set(sources.map(s => s.lang ?? 'all'))].filter(l => l !== 'all').sort().map(lang => <option key={lang} value={lang}>{lang.toUpperCase()}</option>)}</select></div>
      <div className="section-heading"><h3>Available sources</h3><button className="text-btn" onClick={() => setPanel('extensions')}><Icon name="plus" size={16} />Add sources</button></div>
      {[...sources].sort((a, b) => a.name.localeCompare(b.name)).filter(s => `${s.name} ${s.lang ?? ''}`.toLowerCase().includes(sourceQuery.toLowerCase()) && (sourceLanguage === 'all' || s.lang === sourceLanguage)).map(source => <button className="source-browse-row" key={source.id} aria-label={`Browse ${source.name}${source.lang ? ' ' + source.lang.toUpperCase() : ''}`} onClick={() => { setSourceId(source.id); setPanel('titles'); setQuery(''); setSearch(''); }}><span className="extension-avatar"><Icon name="browse" /></span><span><strong>{source.name}</strong><small>{source.lang?.toUpperCase() ?? 'All languages'} · {source.kind === 'suwayomi' ? 'Mihon extension' : source.kind === 'extension' ? 'Web extension' : source.id === 'sample' ? 'Demo' : 'Built in'}</small></span><Icon name="chevron" size={18} /></button>)}
      {!!data?.imported.some(s => !sources.some(available => available.id === s.id) && !['local', '0'].includes(s.id)) && <section className="settings-card"><h3>Sources needed by your library</h3>{data.imported.filter(s => !sources.some(available => available.id === s.id) && !['local', '0'].includes(s.id)).map(source => <div className="source-review-row" key={source.id}><div><strong>{source.name}</strong><small>{source.count} library titles · {source.id}</small></div><span className="chip">Needs extension</span></div>)}<button className="text-btn" onClick={() => setPanel('extensions')}>Find extensions <Icon name="arrow" size={16} /></button></section>}
    </>}
    {panel === 'titles' && <>
    <div className="browse-toolbar"><select aria-label="Browse source" value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="all">All sources</option>{!sources.some(s => s.id === sourceId) && sourceId !== 'all' && <option value={sourceId}>Source unavailable</option>}{sources.map(s => <option key={s.id} value={s.id}>{s.name}{s.lang ? ' (' + s.lang.toUpperCase() + ')' : ''}{s.id === 'sample' ? ' · demo' : ''}</option>)}</select></div>
    <div className="searchbar"><Icon name="search" /><input type="search" aria-label="Search manga" placeholder="Search titles" value={query} onChange={e => setQuery(e.target.value)} /></div>
    {!search && <div className="seg" aria-label="Browse mode"><button className={mode === 'popular' ? 'active' : ''} aria-pressed={mode === 'popular'} onClick={() => setMode('popular')}>Popular</button><button className={mode === 'latest' ? 'active' : ''} aria-pressed={mode === 'latest'} onClick={() => setMode('latest')}>Latest</button></div>}
    {!groups.length && <EmptyState icon="cloud" title="Connect a source"><p>Connect Suwayomi or install a web extension to browse more sources.</p><button className="btn" onClick={nav.openConnections}>Connections</button></EmptyState>}
    {groups.map(group => {
      const source = sources.find(s => s.id === group.id);
      const items = group.items.map(m => ({ key: mangaKey(m.sourceId, m.id), manga: m, inLibrary: library.has(mangaKey(m.sourceId, m.id)) }));
      return <section className="source-section" key={group.id} aria-label={group.name}>
        {sourceId === 'all' && <div className="section-heading"><h3>{group.name}</h3><span>{group.items.length} titles</span></div>}
        {group.error && <div className="inline-error" role="alert">{group.error}{online && source && <button className="text-btn" disabled={group.loading} onClick={() => void loadSource(source, Math.max(1, group.page), generation.current)}>Retry source</button>}{source?.baseUrl && <a className="text-btn" href={source.baseUrl} target="_blank" rel="noopener noreferrer">Open source website</a>}</div>}
        {items.length > 0 && (settings.libraryView === 'grid' ? <MangaGrid items={items} onOpen={nav.openManga} onMenu={openMenu} /> : <MangaList items={items} onOpen={nav.openManga} onMenu={openMenu} />)}
        {group.loading ? <div className="spinner" role="status" aria-label={'Loading ' + group.name} /> : !items.length && !group.error ? <EmptyState icon="search" title="No titles found"><p>Try another search or source.</p></EmptyState> : items.length > 0 && source && !group.exhausted && <div className="load-more"><button className="btn-ghost outlined" disabled={!online} onClick={() => void loadSource(source, group.page + 1, generation.current)}>Load more</button></div>}
      </section>;
    })}
    </>}
    {menuItem && <Sheet title={menuItem.title} onClose={() => setMenuKey('')}>
      {menuError && <p className="error" role="alert">{menuError}</p>}
      <p className="muted">Save this title to one or more library categories.</p>
      {data?.categories.map(c => <label className="form-row" key={c.id}>{c.name}<input type="checkbox" checked={categoryDraft.includes(c.name)} onChange={e => setCategoryDraft(old => e.target.checked ? [...old, c.name] : old.filter(n => n !== c.name))} /></label>)}
      <button className="btn wide" disabled={busy} onClick={() => void menuAction(() => library.has(menuKey) ? setLibraryCategory(menuKey, categoryDraft) : addToLibrary(menuKey, categoryDraft))}>{library.has(menuKey) ? 'Save categories' : 'Add to library'}</button>
      {library.has(menuKey) && <button className="text-btn danger" disabled={busy} onClick={() => { if (window.confirm('Remove this title from your library? Reading progress is kept.')) void menuAction(() => removeFromLibrary(menuKey)); }}>Remove from library</button>}
    </Sheet>}
  </main>;
}
