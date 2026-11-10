import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useOnline, useQueue } from '../lib/hooks';
import { useNav } from '../lib/nav';
import { setDownloadsPaused } from '../lib/downloadQueue';
import Icon from './Icon';

export function PwaStatus() {
  const online = useOnline();
  const [dismissed, setDismissed] = useState(false);
  const { needRefresh: [needRefresh], offlineReady: [offlineReady], updateServiceWorker } = useRegisterSW({ onRegisteredSW(_url, registration) {
    const update = () => { if (navigator.onLine && registration) void registration.update().catch(() => {}); };
    window.addEventListener('online', update);
  } });
  useEffect(() => { if (offlineReady) document.documentElement.dataset.offlineReady = 'true'; }, [offlineReady]);
  if (needRefresh && !dismissed) return <div className="pwa-notice" role="status"><span>App update ready</span><button className="text-btn" onClick={() => void updateServiceWorker(true)}>Update</button><button className="icon-btn" aria-label="Dismiss update" onClick={() => setDismissed(true)}><Icon name="close" size={16} /></button></div>;
  return !online ? <div className="offline-banner" role="status"><Icon name="offline" size={14} />Offline · downloaded chapters are available</div> : null;
}
export function QueueBar() {
  const queue = useQueue();
  const nav = useNav();
  const active = queue.jobs.find(j => j.status === 'downloading') ?? queue.jobs.find(j => j.status !== 'failed');
  if (!active) return null;
  return <div className="mini-download-bar"><button onClick={nav.openDownloads}><Icon name="download" size={19} /><span><strong>{queue.offline ? 'Waiting for connection' : queue.paused ? 'Downloads paused' : active.status === 'downloading' ? active.mangaTitle : 'Download queue'}</strong><small>{active.chapterName} · {active.total ? `${active.done} / ${active.total} pages` : `${queue.jobs.length} queued`}</small></span></button><button className="icon-btn" aria-label={queue.paused ? 'Resume downloads' : 'Pause downloads'} onClick={() => void setDownloadsPaused(!queue.paused)}><Icon name={queue.paused ? 'play' : 'pause'} size={20} /></button></div>;
}
