import { useState } from 'react';
import { clearHistory, dispatchDataEvent, getDB, getHistory, type HistoryRecord } from '../lib/db';
import { useDataEvents, useOnline } from '../lib/hooks';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import { splitMangaKey } from '../sources/Source';
import { getSource } from '../sources';
import Icon from '../components/Icon';
import Cover from '../components/Cover';
import { EmptyState, toast } from '../components/Feedback';

export default function HistoryPage() {
  const nav = useNav();
  const online = useOnline();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, loading, error, reload } = useLoad(async () => {
    const db = await getDB();
    return { history: await getHistory(), downloads: new Set((await db.getAll('downloads')).map(d => d.key)), chapters: new Set((await db.getAll('chapterMeta')).map(c => c.key)) };
  }, []);
  useDataEvents(reload);
  const grouped = new Map<string, HistoryRecord[]>();
  for (const record of data?.history ?? []) {
    if (query && !(record.mangaTitle + ' ' + record.chapterName).toLowerCase().includes(query.toLowerCase())) continue;
    const day = new Date(record.updatedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    const rows = grouped.get(day) ?? []; rows.push(record); grouped.set(day, rows);
  }
  async function clear() {
    if (!window.confirm('Clear all reading history? Read states and bookmarks are kept.')) return;
    setBusy(true);
    try { await clearHistory(); reload(); }
    catch (error) { toast(error instanceof Error ? error.message : 'Unable to clear history'); }
    finally { setBusy(false); }
  }
  return <main className="screen"><header className="topbar"><h1>History</h1><button className="icon-btn" aria-label="Clear reading history" disabled={busy || !data?.history.length} onClick={() => void clear()}><Icon name="trash" /></button></header>
    {!!data?.history.length && <div className="searchbar"><Icon name="search" /><input type="search" aria-label="Search reading history" placeholder="Find a title or chapter" value={query} onChange={e => setQuery(e.target.value)} /></div>}
    {loading && !data ? <div className="spinner" role="status" aria-label="Loading history" /> : error ? <p className="error" role="alert">{error}</p> : !grouped.size ? <EmptyState icon="history" title={query ? 'No matching history' : 'Pick up where you left off'}><p>Your reading history and imported Mihon history appear here.</p><button className="btn" onClick={() => nav.setTab('library')}>Open library</button></EmptyState> : [...grouped].map(([day, rows]) => <section key={day}><h3 className="history-date">{day}</h3>{rows.map(record => {
      const [sourceId] = splitMangaKey(record.mangaKey);
      const chapterId = record.key.slice(record.mangaKey.length + 2);
      const canResume = data!.chapters.has(record.key) && (data!.downloads.has(record.key) || online && !!getSource(sourceId));
      return <div className="history-row" key={record.key}><Cover url={record.coverUrl} title={record.mangaTitle} /><button className="history-title" onClick={() => nav.openManga(record.mangaKey)}><strong>{record.mangaTitle}</strong><small>{record.chapterName}</small><small>Page {record.page + 1} · {new Date(record.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</small></button><button className="icon-btn" aria-label={'Resume ' + record.chapterName} disabled={!canResume} onClick={() => nav.openReader(record.mangaKey, chapterId)}><Icon name="play" filled size={21} /></button><button className="icon-btn" aria-label={'Remove ' + record.chapterName + ' from history'} onClick={() => void getDB().then(db => db.delete('history', record.key)).then(() => { dispatchDataEvent(); reload(); }).catch(error => toast(String(error)))}><Icon name="close" size={17} /></button></div>;
    })}</section>)}
  </main>;
}
