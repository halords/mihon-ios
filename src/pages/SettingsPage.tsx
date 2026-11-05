import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react';
import { loadSettings, saveSettings, type Settings } from '../lib/settings';
import { useNav } from '../lib/nav';
import { exportData, importData, type BackupData } from '../lib/db';
import { deleteMangaDownloads, clearPagesCache } from '../lib/downloads';
import { importTachibkFile } from '../backup/tachibk';

const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  padding: '10px 0',
};

const noteStyle: CSSProperties = {
  display: 'block',
  fontSize: 13,
  lineHeight: 1.5,
  opacity: 0.7,
};

export default function SettingsPage() {
  const nav = useNav();
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [proxyDraft, setProxyDraft] = useState(settings.proxyBase);
  const [usageText, setUsageText] = useState<string>('—');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStorage = useCallback(async (): Promise<void> => {
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        const used = est.usage ?? 0;
        const quota = est.quota ?? 0;
        setUsageText(
          quota > 0
            ? `${(used / 1048576).toFixed(1)} MB of ${(quota / 1048576).toFixed(0)} MB`
            : `${(used / 1048576).toFixed(1)} MB`,
        );
      }
      if (navigator.storage?.persisted) {
        setPersisted(await navigator.storage.persisted());
      }
    } catch {
      setUsageText('Unavailable');
    }
  }, []);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  function apply(patch: Partial<Settings>): void {
    const next = saveSettings(patch);
    setSettings(next);
  }

  async function requestPersist(): Promise<void> {
    try {
      const ok = await navigator.storage.persist();
      setPersisted(ok);
      setMessage(
        ok
          ? 'Storage is now persistent.'
          : 'Browser did not grant persistence.',
      );
    } catch {
      setMessage('Persistence request failed.');
    }
  }

  async function clearDownloads(): Promise<void> {
    if (busy) return;
    if (
      !window.confirm(
        'Delete ALL downloaded chapters? Reading progress is kept.',
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      const data = await exportData();
      const keys = [...new Set(data.downloads.map(d => d.mangaKey))];
      for (const key of keys) {
        await deleteMangaDownloads(key);
      }
      await clearPagesCache();
      setMessage('All downloads deleted.');
      void refreshStorage();
    } catch {
      setMessage('Failed to delete downloads.');
    } finally {
      setBusy(false);
    }
  }

  async function exportJson(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const data = await exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mihon-pwa-backup.json';
      try {
        a.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      setMessage('Library exported.');
    } catch {
      setMessage('Failed to export library.');
    } finally {
      setBusy(false);
    }
  }

  async function onTachibkFile(
    e: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;

    setBusy(true);
    try {
      const result = await importTachibkFile(file);
      setMessage(
        `Mihon backup imported: ${result.mangaCount} manga, ${result.chapterCount} chapters, ${result.historyCount} history entries` +
          (result.mangadexMatched > 0
            ? ` — ${result.mangadexMatched} matched to MangaDex.`
            : '.'),
      );
      void refreshStorage();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Import failed — ${err.message}`
          : 'Import failed — invalid .tachibk file.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function onJsonFile(
    e: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;

    setBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupData;
      if (parsed.version !== 1 || !Array.isArray(parsed.manga)) {
        throw new Error('Not a Mihon PWA backup');
      }
      await importData(parsed);
      setMessage('Library imported.');
      void refreshStorage();
    } catch {
      setMessage('Import failed — invalid backup file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <header className="topbar">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => nav.back()}
        >
          Back
        </button>
        <h1>Settings</h1>
      </header>

      <div style={{ padding: 16 }}>
        {message && (
          <p role="status" style={{ color: 'var(--accent)' }}>
            {message}
          </p>
        )}

        <section>
          <h3>Reader</h3>
          <div style={rowStyle}>
            <label htmlFor="settings-reader-mode">Default reading mode</label>
            <select
              id="settings-reader-mode"
              value={settings.readerMode}
              onChange={e =>
                apply({
                  readerMode: e.target.value as Settings['readerMode'],
                })
              }
            >
              <option value="vertical">Vertical (webtoon)</option>
              <option value="paged">Paged</option>
            </select>
          </div>
          <div style={rowStyle}>
            <label htmlFor="settings-library-view">Library view</label>
            <select
              id="settings-library-view"
              value={settings.libraryView}
              onChange={e =>
                apply({
                  libraryView: e.target.value as Settings['libraryView'],
                })
              }
            >
              <option value="grid">Grid</option>
              <option value="list">List</option>
            </select>
          </div>
        </section>

        <section>
          <h3>Appearance</h3>
          <div style={rowStyle}>
            <label htmlFor="settings-theme">Theme</label>
            <select
              id="settings-theme"
              value={settings.theme}
              onChange={e =>
                apply({ theme: e.target.value as Settings['theme'] })
              }
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <small style={noteStyle}>
            Applies immediately across the app.
          </small>
        </section>

        <section>
          <h3>Network</h3>
          <div
            style={{
              ...rowStyle,
              flexDirection: 'column',
              alignItems: 'stretch',
            }}
          >
            <label htmlFor="settings-proxy-base">
              CORS proxy base (PROXY_BASE)
            </label>
            <input
              id="settings-proxy-base"
              type="url"
              placeholder="https://your-proxy.example/"
              value={proxyDraft}
              onChange={e => setProxyDraft(e.target.value)}
              aria-describedby="settings-proxy-note"
            />
            <button
              type="button"
              className="btn"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                apply({ proxyBase: proxyDraft.trim() });
                setMessage('Proxy saved.');
              }}
            >
              Save proxy
            </button>
          </div>
          <small id="settings-proxy-note" style={noteStyle}>
            Optional. When set, source requests go through this proxy to bypass
            CORS. Leave empty for direct requests.
          </small>
        </section>

        <section>
          <h3>Storage (on-device, local-first)</h3>
          <div style={rowStyle}>
            <span>Storage used</span>
            <span>{usageText}</span>
          </div>
          <div style={rowStyle}>
            <span>Persistent storage</span>
            {persisted === true ? (
              <span className="chip">Persistent</span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={requestPersist}
              >
                Request persistence
              </button>
            )}
          </div>
          <div style={rowStyle}>
            <span>Downloaded chapters</span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={clearDownloads}
            >
              Delete all downloads
            </button>
          </div>
          <small style={noteStyle}>
            Everything is stored only on this device — library, progress,
            history and downloads. There is no account and no server copy.
          </small>
        </section>

        <section
          aria-busy={busy}
          style={{
            marginTop: 24,
            padding: 16,
            border: '1px solid var(--accent)',
            borderRadius: 12,
          }}
        >
          <h3 style={{ marginTop: 0 }}>Backup &amp; restore</h3>
          <small style={{ display: 'block', lineHeight: 1.5 }}>
            No account sync — use these to move your library between devices.
          </small>
          <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
            <button
              type="button"
              className="btn"
              style={{ width: '100%' }}
              disabled={busy}
              onClick={exportJson}
            >
              Export library (JSON)
            </button>
            <label
              className="btn btn-ghost"
              role="button"
              tabIndex={busy ? -1 : 0}
              aria-disabled={busy}
              onKeyDown={e => {
                if (!busy && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  e.currentTarget.querySelector('input')?.click();
                }
              }}
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                width: '100%',
                boxSizing: 'border-box',
                opacity: busy ? 0.5 : 1,
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >
              Import library (JSON)
              <input
                type="file"
                accept="application/json,.json"
                hidden
                disabled={busy}
                onChange={onJsonFile}
              />
            </label>
          </div>
          <label
            className="btn btn-ghost"
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-disabled={busy}
            onKeyDown={e => {
              if (!busy && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                e.currentTarget.querySelector('input')?.click();
              }
            }}
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              width: '100%',
              boxSizing: 'border-box',
              marginTop: 12,
              opacity: busy ? 0.5 : 1,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            Import Mihon Android backup (.tachibk)
            <input
              type="file"
              accept=".tachibk,application/gzip"
              hidden
              disabled={busy}
              onChange={onTachibkFile}
            />
          </label>
          <small style={{ display: 'block', lineHeight: 1.5, marginTop: 8 }}>
            Imports categories, library, read state and history from a Mihon
            (Android) backup. MangaDex entries become fully readable; other
            sources import as library entries marked “source not available in
            PWA yet”.
          </small>
        </section>
      </div>
    </div>
  );
}
