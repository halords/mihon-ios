import { useState } from 'react';
import { getAllDownloads, getAllManga, getDB } from '../lib/db';
import { useLoad } from '../lib/useLoad';
import { useDataEvents, useQueue } from '../lib/hooks';
import { useNav } from '../lib/nav';
import { clearDownloadQueue, removeDownloadJob, retryDownload, setDownloadsPaused } from '../lib/downloadQueue';
import { deleteChapterDownload, deleteMangaDownloads } from '../lib/downloads';
import { exportChapterCbz } from '../lib/localFiles';
import { formatBytes } from '../lib/files';
import Icon from '../components/Icon';
import Cover from '../components/Cover';
import { EmptyState, toast } from '../components/Feedback';

export default function DownloadsPage() {
  const nav = useNav();
  const queue = useQueue();
  const [tab, setTab] = useState<'queue' | 'saved'>(queue.jobs.length ? 'queue' : 'saved');
  const [busy, setBusy] = useState('');
  const { data, loading, error, reload } = useLoad(async () => {
    const [downloads, mangas, metas] = await Promise.all([getAllDownloads(), getAllManga(), (await getDB()).getAll('chapterMeta')]);
    return { downloads, mangas: new Map(mangas.map(m => [m.key, m])), metas: new Map(metas.map(m => [m.key, m])) };
  }, []);
  useDataEvents(reload);
  const groups = new Map<string, NonNullable<typeof data>['downloads']>();
  for (const download of data?.downloads ?? []) { const records = groups.get(download.mangaKey) ?? []; records.push(download); groups.set(download.mangaKey, records); }
  async function action(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    try { await fn(); reload(); } catch (error) { toast(error instanceof Error ? error.message : 'Unable to update downloads'); }
    finally { setBusy(''); }
  }
  return <main className="screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Downloads</h1>{tab === 'queue' && queue.jobs.length > 0 && <button className="icon-btn" aria-label={queue.paused ? 'Resume all downloads' : 'Pause all downloads'} onClick={() => void setDownloadsPaused(!queue.paused)}><Icon name={queue.paused ? 'play' : 'pause'} /></button>}</header>
    <div className="seg download-tabs"><button className={tab === 'queue' ? 'active' : ''} aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>Queue <span>{queue.jobs.length}</span></button><button className={tab === 'saved' ? 'active' : ''} aria-pressed={tab === 'saved'} onClick={() => setTab('saved')}>Downloaded <span>{data?.downloads.length ?? 0}</span></button></div>
    {tab === 'queue' ? <>
      {!!queue.jobs.length && <div className="queue-intro"><p>{queue.offline ? 'Waiting for a connection. Saved chapters are available offline.' : queue.paused ? 'Downloads paused. Your partial pages are kept.' : 'Keep the app open while chapters download. Progress is saved if iOS suspends it.'}</p><button className="text-btn" onClick={() => { if (window.confirm('Cancel all queued downloads and remove their partial pages?')) void action('queue', clearDownloadQueue); }}>Clear queue</button></div>}
      {!queue.jobs.length ? <EmptyState icon="download" title="Nothing in the queue"><p>Download individual chapters or all unread chapters from a title’s page.</p><button className="btn" onClick={() => nav.setTab('library')}>Open library</button></EmptyState> : queue.jobs.map(job => <div className={`queue-item ${job.status === 'failed' ? 'failed' : ''}`} key={job.key}>
        <div className="queue-item-heading"><div><strong>{job.mangaTitle}</strong><span>{job.chapterName}</span></div>{job.status === 'failed' ? <button className="icon-btn" aria-label={`Retry ${job.chapterName}`} disabled={!!busy} onClick={() => void action(job.key, async () => { await setDownloadsPaused(false); await retryDownload(job.key); })}><Icon name="refresh" /></button> : <button className="icon-btn" aria-label={`Cancel ${job.chapterName}`} disabled={!!busy} onClick={() => void action(job.key, () => removeDownloadJob(job.key))}><Icon name="close" /></button>}</div>
        <div className="download-progress" role="progressbar" aria-label={`Download ${job.chapterName}`} aria-valuemin={0} aria-valuemax={job.total || 100} aria-valuenow={job.done}><span style={{ width: `${job.total ? job.done / job.total * 100 : 0}%` }} /></div>
        <small>{job.status === 'failed' ? job.error : queue.paused || job.status === 'paused' ? 'Paused' : queue.offline ? 'Waiting for network' : job.status === 'downloading' ? `${job.done} / ${job.total} pages` : 'Queued'}</small>
      </div>)}
    </> : loading && !data ? <div className="spinner" role="status" /> : error ? <p className="error" role="alert">{error}</p> : !groups.size ? <EmptyState icon="download" title="Your offline shelf is empty"><p>Downloaded chapters will be stored on this device and work in airplane mode.</p><button className="btn" onClick={() => nav.setTab('library')}>Choose a title</button></EmptyState> : <>
      <div className="download-summary"><Icon name="check" size={18} /><span>{data?.downloads.length} chapters · {formatBytes(data?.downloads.reduce((n, d) => n + (d.byteSize ?? 0), 0) ?? 0)}</span></div>
      {[...groups].map(([key, downloads]) => { const manga = data?.mangas.get(key); return <section className="download-group" key={key}><div className="download-group-heading"><button className="download-manga" onClick={() => nav.openManga(key)}>{manga && <Cover url={manga.manga.coverUrl} title={manga.manga.title} />}<span><strong>{manga?.manga.title ?? 'Manga'}</strong><small>{downloads.length} downloaded chapters</small></span></button><button className="icon-btn" aria-label={`Delete downloads for ${manga?.manga.title ?? 'this manga'}`} disabled={!!busy} onClick={() => { if (window.confirm('Delete all downloaded chapters for this title?')) void action(key, () => deleteMangaDownloads(key)); }}><Icon name="trash" size={19} /></button></div>
        {downloads.sort((a, b) => (data?.metas.get(a.key)?.chapter.number ?? 0) - (data?.metas.get(b.key)?.chapter.number ?? 0)).map(download => {
          const chapter = data?.metas.get(download.key)?.chapter;
          return <div className="download-chapter" key={download.key}><button className="download-chapter-open" onClick={() => nav.openReader(key, chapter?.id ?? download.key.slice(key.length + 2))}><Icon name="check" size={17} /><span><strong>{chapter?.name ?? 'Chapter'}</strong><small>{download.pageCount} pages{download.byteSize ? ` · ${formatBytes(download.byteSize)}` : ''}</small></span></button><button className="icon-btn" aria-label={`Export ${chapter?.name ?? 'chapter'} as CBZ`} disabled={!!busy} onClick={() => void action(download.key, () => exportChapterCbz(key, download.key))}><Icon name={busy === download.key ? 'more' : 'backup'} size={18} /></button><button className="icon-btn" aria-label={`Delete ${chapter?.name ?? 'chapter'} download`} disabled={!!busy} onClick={() => { if (window.confirm('Delete this downloaded chapter?')) void action(download.key, () => deleteChapterDownload(key, download.key)); }}><Icon name="trash" size={18} /></button></div>;
        })}</section>; })}
    </>}
  </main>;
}
