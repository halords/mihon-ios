import { useEffect, useRef, useState } from 'react';
import { getManga, getChapterMetas, getChapterStates } from '../lib/db';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import { useSources } from '../lib/hooks';
import { getSource } from '../sources';
import { matchMigrationChapters, migrateManga } from '../lib/migration';
import type { SChapter, SManga } from '../sources/Source';
import { mangaKey } from '../sources/Source';
import Icon from '../components/Icon';
import SourceLogo from '../components/SourceLogo';
import { EmptyState, toast } from '../components/Feedback';

export default function MigrationPage({ mangaKey: originalKey }: { mangaKey: string }) {
  const nav = useNav();
  const sources = useSources();
  const { data } = useLoad(async () => ({ stored: await getManga(originalKey), chapters: await getChapterMetas(originalKey), states: await getChapterStates(originalKey) }), [originalKey]);
  const [sourceId, setSourceId] = useState(originalKey.startsWith('6247824327199706550::') ? '2528986671771677900' : '6247824327199706550');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SManga[]>([]);
  const [busy, setBusy] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const generation = useRef(0);
  const [error, setError] = useState('');
  const [candidate, setCandidate] = useState<{ manga: SManga; chapters: SChapter[] } | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(false);
  useEffect(() => { if (data?.stored) { setQuery(data.stored.manga.title); void search(data.stored.manga.title); } }, [data?.stored?.key]);
  useEffect(() => () => { generation.current++; }, []);
  async function search(value = query, selected = sourceId) {
    const request = ++generation.current;
    const source = getSource(selected);
    setResults([]); setError(''); setCandidate(null);
    if (!source || !value.trim()) { setBusy(false); return; }
    setBusy(true);
    try { const found = await source.searchManga(value.trim(), 1); if (request === generation.current) setResults(found); }
    catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : 'Search failed'); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function review(key: string) {
    const manga = results.find(m => mangaKey(m.sourceId, m.id) === key);
    if (!manga) return;
    const source = getSource(manga.sourceId);
    if (!source) return;
    const request = ++generation.current;
    setBusy(true); setError('');
    try { const [details, chapters] = await Promise.all([source.getMangaDetails(manga.id), source.getChapterList(manga.id)]); if (request === generation.current) setCandidate({ manga: details, chapters }); }
    catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : 'Unable to load replacement'); }
    finally { if (request === generation.current) setBusy(false); }
  }
  const selectedSource = getSource(sourceId);
  const originalSource = data?.stored ? getSource(data.stored.manga.sourceId) : undefined;
  const originalSourceName = originalSource?.name ?? data?.stored?.manga.sourceName ?? data?.stored?.manga.sourceId ?? '';
  const candidateSource = candidate ? getSource(candidate.manga.sourceId) : undefined;
  const candidateSourceName = candidateSource?.name ?? candidate?.manga.sourceName ?? candidate?.manga.sourceId ?? '';
  const progressed = data?.chapters.filter(c => data.states.some(s => s.key === c.key && (s.read || s.bookmark || s.lastPage > 0))) ?? [];
  const matches = candidate ? progressed.filter(c => matchMigrationChapters(c.chapter, candidate.chapters).length).length : 0;
  return <main className="screen migration-screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Migrate source</h1></header>
    {data?.stored && <div className="migration-original"><small>CURRENT TITLE</small><div className="migration-title-row"><SourceLogo id={data.stored.manga.sourceId} name={originalSourceName} iconUrl={originalSource?.iconUrl} /><div><strong>{data.stored.manga.title}</strong><span className="migration-source-name">{originalSourceName}</span></div></div></div>}
    <p className="page-note">Find the same title on an available source, then review its chapters before migrating.</p>
    <form className="migration-search" onSubmit={e => { e.preventDefault(); void search(); }}><select aria-label="Replacement source" value={sourceId} disabled={migrating} onChange={e => { setSourceId(e.target.value); void search(query, e.target.value); }}>{sources.map(source => <option key={source.id} value={source.id}>{source.name}{source.lang ? ` (${source.lang})` : ''}</option>)}</select><div className="searchbar"><Icon name="search" /><input aria-label="Search replacement title" disabled={migrating} value={query} onChange={e => setQuery(e.target.value)} /></div><button className="btn" disabled={busy || !query.trim()}>Search</button></form>
    {error && <div className="error" role="alert">{error}{selectedSource?.baseUrl && <a className="text-btn" href={selectedSource.baseUrl} target="_blank" rel="noopener noreferrer">Open source website</a>}{selectedSource?.kind === "builtin" && selectedSource.id !== "mangadex" && <a className="text-btn" href={"#/connections?source=" + selectedSource.id}>Browser verification</a>}</div>}
    {busy ? <div className="spinner" role="status" aria-label="Loading replacement" /> : candidate ? <section className="settings-card migration-review"><div className="migration-candidate"><small>REPLACEMENT</small><div className="migration-title-row"><SourceLogo id={candidate.manga.sourceId} name={candidateSourceName} iconUrl={candidateSource?.iconUrl} /><div><h2>{candidate.manga.title}</h2><span className="migration-source-name">{candidateSourceName}</span>{candidate.manga.author && <p>{candidate.manga.author}</p>}</div></div></div><p>{candidate.chapters.length} chapters available · {matches} / {progressed.length} chapters with progress matched</p><p className="muted">Read states and bookmarks match by chapter number. Page progress transfers for unambiguous matches. Original chapter files remain with the original title.</p><label className="form-row">Keep original title in library<input type="checkbox" checked={keepOriginal} onChange={e => setKeepOriginal(e.target.checked)} /></label><div className="button-row"><button className="btn" disabled={busy || mangaKey(candidate.manga.sourceId, candidate.manga.id) === originalKey} onClick={() => {
      setMigrating(true); setBusy(true); void migrateManga(originalKey, candidate.manga, candidate.chapters, keepOriginal).then(result => { toast(`${result.matched} chapter states migrated`); nav.openManga(result.key); }).catch(error => { setError(error instanceof Error ? error.message : 'Migration failed'); setBusy(false); setMigrating(false); });
    }}>Migrate to this title</button><button className="text-btn" onClick={() => setCandidate(null)}>Choose another</button></div></section> : results.length ? <div className="migration-results">{results.map(manga => {
      const source = getSource(manga.sourceId);
      const sourceName = source?.name ?? manga.sourceName ?? manga.sourceId;
      return <button className="migration-result" key={mangaKey(manga.sourceId, manga.id)} aria-label={`Open ${manga.title}`} onClick={() => void review(mangaKey(manga.sourceId, manga.id))}><SourceLogo id={manga.sourceId} name={sourceName} iconUrl={source?.iconUrl} /><span><strong>{manga.title}</strong><span className="migration-source-name">{sourceName}</span></span><Icon name="chevron" size={17} /></button>;
    })}</div> : error ? null : <EmptyState icon="search" title="No replacement found"><p>Try a shorter title or another source.</p></EmptyState>}
  </main>;
}
