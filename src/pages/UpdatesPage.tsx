import { useState } from 'react';
import { getDB, getLibrary } from '../lib/db';
import { checkLibraryUpdates, getLibraryUpdates } from '../lib/updates';
import { useDataEvents, useOnline } from '../lib/hooks';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import { getSource } from '../sources';
import Icon from '../components/Icon';
import Cover from '../components/Cover';
import DownloadButton from '../components/DownloadButton';
import { EmptyState, toast } from '../components/Feedback';
import { splitMangaKey } from '../sources/Source';

export default function UpdatesPage() {
  const nav = useNav();
  const online = useOnline();
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState('');
  const [page, setPage] = useState(0);
  const { data, loading, error, reload } = useLoad(async () => {
    const db = await getDB();
    const [library, snapshot] = await Promise.all([getLibrary(), getLibraryUpdates()]);
    const libraryKeys = new Set(library.map(entry => entry.key));
    const updates = (snapshot?.chapters ?? []).filter(update => libraryKeys.has(update.mangaKey));
    const pageCount = Math.ceil(updates.length / 20);
    const currentPage = Math.min(page, Math.max(0, pageCount - 1));
    const visible = updates.slice(currentPage * 20, currentPage * 20 + 20);
    const states = await Promise.all(visible.map(update => db.get('chapterState', update.mangaKey + '::' + update.chapter.id)));
    return { library, snapshot, visible, currentPage, pageCount, states: new Map(states.filter(state => !!state).map(state => [state!.key, state!])) };
  }, [page]);
  useDataEvents(reload);
  async function refresh() {
    setRefreshing(true);
    try { await checkLibraryUpdates((done, total) => setProgress(done + ' / ' + total + ' titles')); setPage(0); reload(); }
    catch (error) { toast(error instanceof Error ? error.message : 'Unable to check updates'); }
    finally { setRefreshing(false); setProgress(''); }
  }
  return <main className="screen"><header className="topbar"><h1>Updates</h1><button className="icon-btn" aria-label="Check library updates" disabled={refreshing || !online || !data?.library.length} onClick={() => void refresh()}><Icon name="refresh" /></button></header>
    {refreshing && <p className="status-message" role="status">Checking {progress}…</p>}
    {data?.snapshot && <p className="update-summary">Checked {new Date(data.snapshot.lastChecked).toLocaleString()} · {data.snapshot.checked} titles checked · {data.snapshot.found} new chapters{data.snapshot.unavailable ? ' · ' + data.snapshot.unavailable + ' titles need sources or local files' : ''}</p>}
    {!!data?.snapshot?.failures.length && <details className="notes-section"><summary>{data.snapshot.failures.length} titles could not be checked</summary>{data.snapshot.failures.map((message, i) => <p className="muted" key={i}>{message}</p>)}</details>}
    {loading && !data ? <div className="spinner" role="status" aria-label="Loading updates" /> : error ? <p className="error" role="alert">{error}</p> : !data?.library.length ? <EmptyState icon="refresh" title="Your next chapter awaits"><p>Add titles to your library to check for new chapters.</p><button className="btn" onClick={() => nav.setTab('browse')}>Browse sources</button></EmptyState> : !data.visible.length ? <EmptyState icon="refresh" title={data.snapshot ? 'No new chapters yet' : 'Check your library'}><p>{online ? 'Check your connected sources for new chapters. Results stay saved on this device.' : 'Reconnect to check for new chapters. Your downloads are available offline.'}</p><button className="btn" disabled={!online || refreshing} onClick={() => void refresh()}>Check for updates</button></EmptyState> : data.visible.map(update => {
      const key = update.mangaKey + '::' + update.chapter.id;
      const [sourceId, mangaId] = splitMangaKey(update.mangaKey);
      const downloaded = !!data.states.get(key)?.downloaded;
      return <div className="update-row" key={key}><Cover url={update.coverUrl} title={update.mangaTitle} /><button className="update-title" onClick={() => nav.openManga(update.mangaKey)}><strong>{update.mangaTitle}</strong><small>{update.chapter.name}</small><small>{new Date(update.foundAt).toLocaleDateString()}{data.states.get(key)?.read ? ' · Read' : ' · Unread'}</small></button><button className="icon-btn accent" aria-label={'Read ' + update.chapter.name} disabled={!downloaded && !(online && getSource(sourceId))} onClick={() => nav.openReader(update.mangaKey, update.chapter.id)}><Icon name="play" size={21} /></button><DownloadButton mangaKey={update.mangaKey} sourceId={sourceId} mangaId={mangaId} chapterId={update.chapter.id} downloaded={downloaded} /></div>;
    })}
    {!!data && data.pageCount > 1 && <nav className="history-pagination" aria-label="Update pages"><button className="btn secondary" disabled={loading || data.currentPage === 0} onClick={() => { setPage(data.currentPage - 1); window.scrollTo(0, 0); }}>Newer updates</button><button className="btn" disabled={loading || data.currentPage + 1 >= data.pageCount} onClick={() => { setPage(data.currentPage + 1); window.scrollTo(0, 0); }}>Older updates</button></nav>}
  </main>;
}
