import { useState } from 'react';
import { chapterKey } from '../sources/Source';
import { deleteChapterDownload } from '../lib/downloads';
import { enqueueChapters, removeDownloadJob, retryDownload } from '../lib/downloadQueue';
import { useQueue } from '../lib/hooks';
import Icon from './Icon';
import { toast } from './Feedback';

export default function DownloadButton({ mangaKey, sourceId, mangaId, chapterId, downloaded }: {
  mangaKey: string; sourceId: string; mangaId: string; chapterId: string; downloaded: boolean;
}) {
  const queue = useQueue();
  const job = queue.jobs.find(j => j.key === chapterKey(sourceId, mangaId, chapterId));
  const [busy, setBusy] = useState(false);
  async function act(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (downloaded) {
        if (window.confirm('Delete this chapter’s downloaded pages? Reading progress is kept.')) await deleteChapterDownload(mangaKey, chapterKey(sourceId, mangaId, chapterId));
      } else if (job?.status === 'failed') await retryDownload(job.key);
      else if (job) await removeDownloadJob(job.key);
      else { await enqueueChapters(mangaKey, [chapterId]); toast('Added to download queue'); }
    } catch (error) { toast(error instanceof Error ? error.message : 'Download failed'); }
    finally { setBusy(false); }
  }
  const label = downloaded ? 'Delete download' : job?.status === 'failed' ? 'Retry download' : job ? 'Cancel queued download' : 'Download chapter';
  return <button type="button" className={`icon-btn chapter-download ${downloaded ? 'is-downloaded' : ''}`} aria-label={label} title={job?.error ?? label} disabled={busy} onClick={event => { event.stopPropagation(); void act(); }}>
    {job?.status === 'downloading' ? <span className="download-percent">{job.total ? Math.round(job.done / job.total * 100) : 0}%</span> : <Icon name={downloaded ? 'check' : job?.status === 'failed' ? 'refresh' : job ? 'pause' : 'download'} size={20} />}
  </button>;
}
