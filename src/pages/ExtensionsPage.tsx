import { useCallback, useEffect, useState } from 'react';
import { useNav } from '../lib/nav';
import { loadSettings, saveSettings } from '../lib/settings';
import { getInstalledPlugins, type InstalledPluginRecord } from '../lib/db';
import {
  fetchExtensionIndex,
  installExtension,
  isUpdateAvailable,
  pluginErrors,
  removeExtension,
  type ExtensionIndex,
  type ExtensionManifest,
} from '../lib/plugins';

const DEMO_INDEX_URL = '/extensions-demo/index.json';

interface IndexState {
  url: string;
  builtin?: boolean;
  index?: ExtensionIndex;
  error?: string;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '10px 0',
  borderBottom: '1px solid var(--border, #2a2a2e)',
};

export default function ExtensionsPage() {
  const nav = useNav();
  const [indexUrls, setIndexUrls] = useState<string[]>(
    () => loadSettings().extensionIndexes,
  );
  const [indexStates, setIndexStates] = useState<IndexState[]>([]);
  const [installed, setInstalled] = useState<InstalledPluginRecord[]>([]);
  const [newIndexUrl, setNewIndexUrl] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refreshInstalled = useCallback(async () => {
    setInstalled(await getInstalledPlugins());
  }, []);

  const loadIndexes = useCallback(async (urls: string[]) => {
    const all: IndexState[] = [
      { url: DEMO_INDEX_URL, builtin: true },
      ...urls.map((url) => ({ url })),
    ];
    setIndexStates(all);
    await Promise.all(
      all.map(async (state) => {
        try {
          const index = await fetchExtensionIndex(state.url);
          setIndexStates((prev) =>
            prev.map((s) => (s.url === state.url ? { ...s, index } : s)),
          );
        } catch (error) {
          setIndexStates((prev) =>
            prev.map((s) =>
              s.url === state.url
                ? {
                    ...s,
                    error:
                      error instanceof Error
                        ? error.message
                        : 'Failed to load index.',
                  }
                : s,
            ),
          );
        }
      }),
    );
  }, []);

  useEffect(() => {
    void refreshInstalled();
    void loadIndexes(indexUrls);
    // Only on mount; index list changes reload explicitly below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleInstall(manifest: ExtensionManifest, indexUrl: string) {
    setBusyId(manifest.id);
    setMessage(null);
    try {
      await installExtension(manifest, indexUrl);
      await refreshInstalled();
      setMessage(`Installed ${manifest.name}. It is now a source in Browse.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Install failed.',
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(id: string, name: string) {
    setBusyId(id);
    setMessage(null);
    try {
      await removeExtension(id);
      await refreshInstalled();
      setMessage(`Removed ${name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Remove failed.');
    } finally {
      setBusyId(null);
    }
  }

  function handleAddIndex() {
    const url = newIndexUrl.trim();
    if (!url) return;
    if (indexUrls.includes(url)) {
      setMessage('That index is already added.');
      return;
    }
    const next = [...indexUrls, url];
    saveSettings({ extensionIndexes: next });
    setIndexUrls(next);
    setNewIndexUrl('');
    void loadIndexes(next);
  }

  function handleRemoveIndex(url: string) {
    const next = indexUrls.filter((u) => u !== url);
    saveSettings({ extensionIndexes: next });
    setIndexUrls(next);
    void loadIndexes(next);
  }

  const installedById = new Map(installed.map((p) => [p.id, p]));

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
        <h1>Extensions</h1>
      </header>

      <div style={{ padding: 16 }}>
        {message && (
          <p role="status" style={{ color: 'var(--accent)' }}>
            {message}
          </p>
        )}

        <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
          Extensions are source plugins written in JavaScript. Installing one
          adds it as a source everywhere in the app — Browse, search, the
          reader, downloads — exactly like the built-in sources. A plugin
          registered under a Mihon source ID automatically makes imported
          backup entries for that source readable.
        </p>
        <p style={{ opacity: 0.8, lineHeight: 1.5 }}>
          <strong>Trust:</strong> extension code runs with the app's
          privileges — there is no sandbox in a web app. Only add indexes you
          control or fully trust.
        </p>

        <section>
          <h3>Installed</h3>
          {installed.length === 0 && (
            <p style={{ opacity: 0.7 }}>No extensions installed yet.</p>
          )}
          {installed.map((plugin) => {
            const error = pluginErrors.get(plugin.id);
            return (
              <div key={plugin.id} style={rowStyle}>
                <div>
                  <div>{plugin.name}</div>
                  <div style={{ opacity: 0.7, fontSize: 13 }}>
                    {plugin.id} · v{plugin.version}
                    {error ? ` · failed to load: ${error}` : ' · active'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busyId === plugin.id}
                  onClick={() => void handleRemove(plugin.id, plugin.name)}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </section>

        <section>
          <h3>Add an extension index</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="url"
              placeholder="https://…/index.json"
              value={newIndexUrl}
              onChange={(e) => setNewIndexUrl(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn" onClick={handleAddIndex}>
              Add
            </button>
          </div>
          <p style={{ opacity: 0.7, fontSize: 13 }}>
            An index is a JSON file listing extension modules. It can be
            hosted anywhere that serves it over HTTPS — a GitHub repo works.
          </p>
        </section>

        {indexStates.map((state) => (
          <section key={state.url}>
            <h3>
              {state.index?.name ??
                (state.builtin ? 'Built-in demo index' : state.url)}
            </h3>
            {!state.builtin && (
              <div style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => handleRemoveIndex(state.url)}
                >
                  Remove index
                </button>
              </div>
            )}
            {state.error && (
              <p style={{ color: 'var(--accent)' }}>{state.error}</p>
            )}
            {!state.index && !state.error && (
              <p style={{ opacity: 0.7 }}>Loading…</p>
            )}
            {state.index?.sources.map((manifest) => {
              const record = installedById.get(manifest.id);
              const update = isUpdateAvailable(manifest, record);
              return (
                <div key={manifest.id} style={rowStyle}>
                  <div>
                    <div>{manifest.name}</div>
                    <div style={{ opacity: 0.7, fontSize: 13 }}>
                      {manifest.id} · v{manifest.version}
                      {manifest.lang ? ` · ${manifest.lang}` : ''}
                      {manifest.nsfw ? ' · 18+' : ''}
                    </div>
                  </div>
                  {record && !update ? (
                    <span className="chip">Installed</span>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={busyId === manifest.id}
                      onClick={() => void handleInstall(manifest, state.url)}
                    >
                      {busyId === manifest.id
                        ? 'Working…'
                        : update
                          ? `Update to v${manifest.version}`
                          : 'Install'}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
