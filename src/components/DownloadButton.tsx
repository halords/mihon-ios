import { useState } from 'react';
import { chapterKey } from '../sources/Source';
import { downloadChapter, deleteChapterDownload } from '../lib/downloads';

export default function DownloadButton(props: {
  mangaKey: string;
  sourceId: string;
  mangaId: string;
  chapterId: string;
  downloaded: boolean;
}): React.JSX.Element {
  const { mangaKey, sourceId, mangaId, chapterId, downloaded } = props;
  const [busy, setBusy] = useState<boolean>(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cKey = chapterKey(sourceId, mangaId, chapterId);

  return (
    <span onClick={(e) => e.stopPropagation()}>
      {busy ? (
        <button
          type="button"
          className="btn btn-ghost"
          disabled
          style={{ minWidth: 44, minHeight: 44 }}
        >
          {progress
            ? `${Math.round((progress.done / progress.total) * 100)}%`
            : '…'}
        </button>
      ) : downloaded ? (
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Delete download"
          title="Downloaded — tap to delete"
          style={{ minWidth: 44, minHeight: 44 }}
          onClick={async () => {
            if (window.confirm('Delete this downloaded chapter?')) {
              setBusy(true);
              try {
                await deleteChapterDownload(mangaKey, cKey);
                window.dispatchEvent(new Event('mihon:downloads-changed'));
              } catch {
                setError('Failed');
              } finally {
                setBusy(false);
              }
            }
          }}
        >
          ✓
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Download chapter"
          style={{ minWidth: 44, minHeight: 44 }}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await downloadChapter(
                mangaKey,
                cKey,
                sourceId,
                mangaId,
                chapterId,
                (done, total) => setProgress({ done, total }),
              );
              window.dispatchEvent(new Event('mihon:downloads-changed'));
            } catch {
              setError('Failed');
            } finally {
              setBusy(false);
              setProgress(null);
            }
          }}
        >
          ↓
        </button>
      )}
      {error && (
        <span className="error" style={{ fontSize: '0.7rem' }}>
          {error}
        </span>
      )}
    </span>
  );
}
