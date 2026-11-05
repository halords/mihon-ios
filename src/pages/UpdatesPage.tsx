import { useState } from 'react';
import { useNav } from '../lib/nav';
import { useLoad } from '../lib/useLoad';
import {
  getLibrary,
  getManga,
  getChapterMetas,
  getChapterStates,
  putChapterMetas,
} from '../lib/db';
import type { SManga, SChapter } from '../sources/Source';
import { getSource } from '../sources';
import { cdnUrl } from '../lib/fetchJson';

interface UpdateRow {
  mangaKey: string;
  manga: SManga;
  totalChapters: number;
  unread: number;
  sourceOk: boolean;
}

interface NewChapter {
  mangaKey: string;
  mangaTitle: string;
  chapter: SChapter;
}

export default function UpdatesPage() {
  const nav = useNav();
  const [refreshing, setRefreshing] = useState(false);
  const [newChapters, setNewChapters] = useState<NewChapter[] | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const { data, loading, error, reload } = useLoad<UpdateRow[]>(async () => {
    const library = await getLibrary();
    const rows: UpdateRow[] = [];

    for (const entry of library) {
      const stored = await getManga(entry.key);
      if (!stored) continue;

      const [sourceId = ''] = entry.key.split('::');
      const metas = await getChapterMetas(entry.key);
      const states = await getChapterStates(entry.key);
      const readKeys = new Set(states.filter((s) => s.read).map((s) => s.key));
      const unread = metas.filter((m) => !readKeys.has(m.key)).length;
      const sourceOk = !!getSource(sourceId) && stored.sourceAvailable;

      rows.push({
        mangaKey: entry.key,
        manga: stored.manga,
        totalChapters: metas.length,
        unread,
        sourceOk,
      });
    }

    return rows.sort((a, b) => a.manga.title.localeCompare(b.manga.title));
  }, []);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);

    try {
      const library = await getLibrary();
      const sourceIds = new Set(
        library.map((entry) => entry.key.split('::')[0] ?? ''),
      );

      // Check each source before diffing any chapter lists.
      for (const sourceId of sourceIds) {
        const source = getSource(sourceId);
        if (source) {
          try {
            await source.getLatestUpdates(1);
          } catch {
            // A latest-updates failure should not prevent chapter checks.
          }
        }
      }

      const found: NewChapter[] = [];

      for (const entry of library) {
        const key = entry.key;
        const sep = key.indexOf('::');
        const sourceId = key.slice(0, sep);
        const mangaId = key.slice(sep + 2);
        const source = getSource(sourceId);
        if (!source) continue;

        const stored = await getManga(key);
        if (!stored) continue;

        const before = await getChapterMetas(key);
        const beforeIds = new Set(before.map((m) => m.chapter.id));
        const fresh = await source.getChapterList(mangaId);
        const newOnes = fresh.filter((c) => !beforeIds.has(c.id));

        if (newOnes.length > 0) {
          await putChapterMetas(sourceId, mangaId, fresh);
          for (const chapter of newOnes) {
            found.push({
              mangaKey: key,
              mangaTitle: stored.manga.title,
              chapter,
            });
          }
        }
      }

      found.sort((a, b) => b.chapter.dateUpload - a.chapter.dateUpload);
      setNewChapters(found);
      setLastChecked(Date.now());
      reload();
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <h1>Updates</h1>
        <button
          type="button"
          className="btn"
          disabled={refreshing}
          onClick={refresh}
        >
          {refreshing ? 'Checking…' : 'Refresh'}
        </button>
      </header>

      {refreshError && (
        <div className="error">
          <p role="alert">{refreshError}</p>
        </div>
      )}

      {newChapters !== null && (
        <section>
          <h3>New chapters</h3>
          {newChapters.length === 0 ? (
            <div className="empty">
              No new chapters found
              {lastChecked
                ? ` · checked ${new Date(lastChecked).toLocaleTimeString()}`
                : ''}
            </div>
          ) : (
            newChapters.map((nc) => (
              <button
                type="button"
                className="list-row"
                key={`${nc.mangaKey}::${nc.chapter.id}`}
                style={{ width: '100%', textAlign: 'left' }}
                onClick={() => nav.openReader(nc.mangaKey, nc.chapter.id)}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{nc.mangaTitle}</div>
                  <small style={{ display: 'block', opacity: 0.65 }}>
                    {nc.chapter.name}
                  </small>
                  <small style={{ display: 'block', opacity: 0.65 }}>
                    {new Date(nc.chapter.dateUpload).toLocaleDateString()}
                  </small>
                </div>
              </button>
            ))
          )}
        </section>
      )}

      <section>
        <h3>Library status</h3>
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
              Your library is empty. Add manga from Browse.
            </div>
          ) : (
            data.map((row) => (
              <button
                type="button"
                className="list-row"
                key={row.mangaKey}
                style={{ width: '100%', textAlign: 'left' }}
                onClick={() => nav.openManga(row.mangaKey)}
              >
                {row.manga.coverUrl ? (
                  <img referrerPolicy="no-referrer"
                    src={cdnUrl(row.manga.coverUrl)}
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
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{row.manga.title}</div>
                  <small style={{ display: 'block', opacity: 0.65 }}>
                    {`${row.totalChapters} chapters`}
                  </small>
                </div>
                {row.unread > 0 && (
                  <span className="chip">{row.unread} unread</span>
                )}
                {!row.sourceOk && <span className="chip">No source</span>}
              </button>
            ))
          ))}
      </section>
    </div>
  );
}
