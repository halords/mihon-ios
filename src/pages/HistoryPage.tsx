import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearHistory, dispatchDataEvent, getDB, type HistoryRecord } from '../lib/db';
import { loadHistoryPage, type HistoryCursor, type HistoryPageData } from '../lib/history';
import { useDataEvents, useOnline } from '../lib/hooks';
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
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [starts, setStarts] = useState<(HistoryCursor | undefined)[]>([undefined]);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<HistoryPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRequest = useRef<AbortController | null>(null);
  const before = starts[starts.length - 1];
  const reload = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => setRevision(value => value + 1), 100);
  }, []);
  useDataEvents(reload);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim().toLowerCase()); setStarts([undefined]); setRevision(value => value + 1);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true); setError('');
    void loadHistoryPage({ before, query: search, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setData(result); setLoading(false); }
    }).catch(cause => {
      if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
    });
    return () => controller.abort();
  }, [before, search, revision]);
  const grouped = useMemo(() => {
    const days = new Map<string, HistoryRecord[]>();
    const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    for (const record of data?.records ?? []) {
      const day = dateFormat.format(record.updatedAt);
      const rows = days.get(day) ?? []; rows.push(record); days.set(day, rows);
    }
    return [...days];
  }, [data]);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }), []);
  async function clear() {
    if (!window.confirm('Clear all reading history? Read states and bookmarks are kept.')) return;
    setBusy(true);
    try { await clearHistory(); setStarts([undefined]); reload(); }
    catch (cause) { toast(cause instanceof Error ? cause.message : 'Unable to clear history'); }
    finally { setBusy(false); }
  }
  async function remove(record: HistoryRecord) {
    try {
      await (await getDB()).delete('history', record.key);
      setData(previous => previous ? { ...previous, records: previous.records.filter(row => row.key !== record.key), total: previous.total - 1 } : previous);
      dispatchDataEvent();
    } catch (cause) { toast(cause instanceof Error ? cause.message : 'Unable to remove history'); }
  }
  function changePage(next: (HistoryCursor | undefined)[]) {
    setData(null); setLoading(true); setStarts(next); window.scrollTo(0, 0);
  }
  return <main className="screen"><header className="topbar"><h1>History</h1><button className="icon-btn" aria-label="Clear reading history" disabled={busy || !data?.total} onClick={() => void clear()}><Icon name="trash" /></button></header>
    <div className="searchbar"><Icon name="search" /><input type="search" aria-label="Search reading history" placeholder="Find a title or chapter" value={query} onChange={event => {
      activeRequest.current?.abort(); setQuery(event.target.value); setData(null); setLoading(true);
    }} /></div>
    {loading && <div className="history-loading" role="status"><span className="spinner" />{search || query ? 'Searching history…' : 'Loading history…'}</div>}
    {error ? <p className="error" role="alert">{error}<button className="text-btn" onClick={reload}>Retry</button></p> : !loading && !grouped.length ? <EmptyState icon="history" title={search ? 'No matching history' : 'Pick up where you left off'}><p>{search ? 'Try another title or chapter.' : 'Your reading history and imported Mihon history appear here.'}</p>{!search && <button className="btn" onClick={() => nav.setTab('library')}>Open library</button>}</EmptyState> : grouped.map(([day, rows]) => <section key={day}><h3 className="history-date">{day}</h3>{rows.map(record => {
      const [sourceId] = splitMangaKey(record.mangaKey);
      const chapterId = record.key.slice(record.mangaKey.length + 2);
      const canResume = data!.chapters.has(record.key) && (data!.downloads.has(record.key) || online && !!getSource(sourceId));
      return <div className="history-row" key={record.key}><Cover url={record.coverUrl} title={record.mangaTitle} /><button className="history-title" onClick={() => nav.openManga(record.mangaKey)}><strong>{record.mangaTitle}</strong><small>{record.chapterName}</small><small>Page {record.page + 1} · {timeFormat.format(record.updatedAt)}</small></button><button className="icon-btn" aria-label={'Resume ' + record.chapterName} disabled={!canResume} onClick={() => nav.openReader(record.mangaKey, chapterId)}><Icon name="play" filled size={21} /></button><button className="icon-btn" aria-label={'Remove ' + record.chapterName + ' from history'} onClick={() => void remove(record)}><Icon name="close" size={17} /></button></div>;
    })}</section>)}
    {(starts.length > 1 || data?.next) && <nav className="history-pagination" aria-label="History pages"><button className="btn secondary" disabled={loading || starts.length === 1} onClick={() => changePage(starts.slice(0, -1))}>Newer history</button><button className="btn" disabled={loading || !data?.next} onClick={() => { if (data?.next) changePage([...starts, data.next]); }}>Older history</button></nav>}
  </main>;
}
