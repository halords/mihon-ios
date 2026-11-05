import { useNav } from '../lib/nav';
import { useLoad } from '../lib/useLoad';
import { getHistory, clearHistory } from '../lib/db';
import { cdnUrl } from '../lib/fetchJson';

export default function HistoryPage() {
  const nav = useNav();
  const { data, loading, error, reload } = useLoad(async () => {
    const records = await getHistory();
    return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  }, []);

  async function clear() {
    if (window.confirm('Clear reading history?')) {
      await clearHistory();
      reload();
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <h1>History</h1>
        {data !== null && data.length > 0 && (
          <button type="button" className="btn btn-ghost" onClick={clear}>
            Clear
          </button>
        )}
      </header>

      {loading && <div className="spinner" role="status" />}
      {error && (
        <div className="error">
          <p role="alert">{error}</p>
          <button type="button" className="btn" onClick={reload}>
            Retry
          </button>
        </div>
      )}

      {data !== null &&
        (data.length === 0 ? (
          <div className="empty">
            Nothing read yet. Open a chapter and it will show up here.
          </div>
        ) : (
          data.map((record) => {
            // chapterKey = `${sourceId}::${mangaId}::${chapterId}` and
            // mangaKey = `${sourceId}::${mangaId}`, so the chapter id is
            // whatever follows the mangaKey plus the '::' separator.
            const chapterId = record.key.slice(record.mangaKey.length + 2);

            return (
              <div className="list-row" key={record.key}>
                {record.coverUrl ? (
                  <img referrerPolicy="no-referrer"
                    src={cdnUrl(record.coverUrl)}
                    alt=""
                    width={40}
                    style={{ flexShrink: 0 }}
                  />
                ) : (
                  <div
                    className="cover"
                    style={{ width: 40, height: 56, flexShrink: 0 }}
                  />
                )}

                <button
                  type="button"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'none',
                    border: 'none',
                    textAlign: 'left',
                    font: 'inherit',
                    cursor: 'pointer',
                    color: 'var(--text)',
                  }}
                  onClick={() => nav.openManga(record.mangaKey)}
                >
                  <div style={{ fontWeight: 600 }}>{record.mangaTitle}</div>
                  <small style={{ display: 'block', opacity: 0.65 }}>
                    {record.chapterName}
                  </small>
                </button>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 4,
                    textAlign: 'right',
                  }}
                >
                  <small style={{ opacity: 0.65 }}>
                    {`Page ${record.page + 1}`}
                  </small>
                  <small style={{ opacity: 0.65 }}>
                    {new Date(record.updatedAt).toLocaleString()}
                  </small>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => nav.openReader(record.mangaKey, chapterId)}
                  >
                    Resume
                  </button>
                </div>
              </div>
            );
          })
        ))}
    </div>
  );
}
