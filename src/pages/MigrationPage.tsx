import { useEffect, useState } from 'react';
import { getManga, getChapterMetas, getChapterStates } from '../lib/db';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import { useSources } from '../lib/hooks';
import { getSource } from '../sources';
import { matchMigrationChapters, migrateManga } from '../lib/migration';
import type { SChapter, SManga } from '../sources/Source';
import { mangaKey } from '../sources/Source';
import { MangaGrid } from '../components/MangaViews';
import Cover from '../components/Cover';
import Icon from '../components/Icon';
import { EmptyState, toast } from '../components/Feedback';

export default function MigrationPage({ mangaKey: originalKey }: { mangaKey: string }) {
  const nav = useNav();
  const sources = useSources();
  const { data } = useLoad(async () => ({ stored: await getManga(originalKey), chapters: await getChapterMetas(originalKey), states: await getChapterStates(originalKey) }), [originalKey]);
  const [sourceId, setSourceId] = useState('mangadex');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SManga[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [candidate, setCandidate] = useState<{ manga: SManga; chapters: SChapter[] } | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(false);
  useEffect(() => { if (data?.stored) { setQuery(data.stored.manga.title); void search(data.stored.manga.title); } }, [data?.stored?.key]);
  async function search(value = query) {
    const source = getSource(sourceId);
    if (!source || !value.trim()) return;
    setBusy(true); setError(''); setCandidate(null);
    try { setResults(await source.searchManga(value.trim(), 1)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Search failed'); }
    finally { setBusy(false); }
  }
  async function review(key: string) {
    const manga = results.find(m => mangaKey(m.sourceId, m.id) === key);
    if (!manga) return;
    const source = getSource(manga.sourceId);
    if (!source) return;
    setBusy(true); setError('');
    try { const [details, chapters] = await Promise.all([source.getMangaDetails(manga.id), source.getChapterList(manga.id)]); setCandidate({ manga: details, chapters }); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to load replacement'); }
    finally { setBusy(false); }
  }
  const progressed = data?.chapters.filter(c => data.states.some(s => s.key === c.key && (s.read || s.bookmark || s.lastPage > 0))) ?? [];
  const matches = candidate ? progressed.filter(c => matchMigrationChapters(c.chapter, candidate.chapters).length).length : 0;
  return <main className="screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Migrate source</h1></header>
    {data?.stored && <div className="migration-original"><Cover url={data.stored.manga.coverUrl} title={data.stored.manga.title} /><div><small>CURRENT TITLE</small><strong>{data.stored.manga.title}</strong><span>{data.stored.manga.sourceName ?? data.stored.manga.sourceId}</span></div></div>}
    <p className="page-note">Find the same title on an available source, then review its chapters before migrating.</p>
    <form className="migration-search" onSubmit={e => { e.preventDefault(); void search(); }}><select aria-label="Replacement source" value={sourceId} onChange={e => setSourceId(e.target.value)}>{sources.map(source => <option key={source.id} value={source.id}>{source.name}{source.lang ? ` (${source.lang})` : ''}</option>)}</select><div className="searchbar"><Icon name="search" /><input aria-label="Search replacement title" value={query} onChange={e => setQuery(e.target.value)} /></div><button className="btn" disabled={busy || !query.trim()}>Search</button></form>
    {error && <div className="error" role="alert">{error}</div>}
    {busy ? <div className="spinner" role="status" aria-label="Loading replacement" /> : candidate ? <section className="settings-card migration-review"><div className="manga-hero"><Cover url={candidate.manga.coverUrl} title={candidate.manga.title} /><div><small>REPLACEMENT</small><h2>{candidate.manga.title}</h2><p>{candidate.manga.author}</p><span>{getSource(candidate.manga.sourceId)?.name}</span></div></div><p>{candidate.chapters.length} chapters available · {matches} / {progressed.length} chapters with progress matched</p><p className="muted">Read states and bookmarks match by chapter number. Page progress transfers for unambiguous matches. Original chapter files remain with the original title.</p><label className="form-row">Keep original title in library<input type="checkbox" checked={keepOriginal} onChange={e => setKeepOriginal(e.target.checked)} /></label><div className="button-row"><button className="btn" disabled={busy || mangaKey(candidate.manga.sourceId, candidate.manga.id) === originalKey} onClick={() => {
      setBusy(true); void migrateManga(originalKey, candidate.manga, candidate.chapters, keepOriginal).then(result => { toast(`${result.matched} chapter states migrated`); nav.openManga(result.key); }).catch(error => { setError(error instanceof Error ? error.message : 'Migration failed'); setBusy(false); });
    }}>Migrate to this title</button><button className="text-btn" onClick={() => setCandidate(null)}>Choose another</button></div></section> : results.length ? <MangaGrid items={results.map(m => ({ key: mangaKey(m.sourceId, m.id), manga: m }))} onOpen={key => void review(key)} /> : <EmptyState icon="search" title="No replacement found"><p>Try a shorter title or another source.</p></EmptyState>}
  </main>;
}
