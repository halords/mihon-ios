import { useState } from 'react';
import { useConnection, useDataEvents, useOnline } from '../lib/hooks';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import { getDB } from '../lib/db';
import { addServerExtensionStore, getServerExtensions, getServerExtensionStores, refreshServerExtensions, removeServerExtensionStore, updateServerExtension } from '../lib/serverExtensions';
import Icon from './Icon';
import SourceLogo from './SourceLogo';
import { EmptyState } from './Feedback';

export default function AndroidExtensionsPanel() {
  const nav = useNav();
  const connection = useConnection();
  const online = useOnline();
  const connected = connection.status === 'connected';
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState('all');
  const [status, setStatus] = useState<'all' | 'installed' | 'available' | 'updates'>('all');
  const [storeUrl, setStoreUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const { data, error, loading, reload } = useLoad(async () => {
    const metadata = (await (await getDB()).get('metadata', 'mihon:extension-stores'))?.value;
    const imported = Array.isArray(metadata) ? metadata.filter((s): s is { indexUrl: string; name: string } => s && typeof s.indexUrl === 'string' && typeof s.name === 'string') : [];
    const [extensions, stores] = connected ? await Promise.all([getServerExtensions(connection.url), getServerExtensionStores(connection.url)]) : [[], []];
    return { imported, extensions, stores };
  }, [connected, connection.url]);
  useDataEvents(reload);
  async function run(id: string, action: () => Promise<void>, success: string) {
    if (busy || !connected || !online) return;
    setBusy(id); setMessage(''); setActionError('');
    try { await action(); setMessage(success); reload(); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Unable to manage extensions'); reload(); }
    finally { setBusy(''); }
  }
  const extensions = data?.extensions ?? [];
  const stores = data?.stores ?? [];
  const visible = extensions.filter(e => `${e.name} ${e.lang} ${e.pkgName}`.toLowerCase().includes(query.toLowerCase()) &&
    (lang === 'all' || e.lang === lang) && (status === 'all' || status === 'installed' && e.isInstalled || status === 'available' && !e.isInstalled || status === 'updates' && e.hasUpdate));
  const saved = (data?.imported ?? []).filter(s => !stores.some(active => active.indexUrl === s.indexUrl));
  const disabled = !!busy || !connected || !online;
  return <div className="extension-manager">
    <p className="muted">Use Mihon-compatible sources for browsing, reading and downloads. Android extensions run on your connected Suwayomi server.</p>
    {message && <p className="status-message" role="status">{message}</p>}
    {(actionError || error) && <div className="inline-error" role="alert">{actionError || error}<button className="text-btn" disabled={disabled} onClick={reload}>Retry catalog</button></div>}
    {!connected && <EmptyState icon="cloud" title="Connect to load Mihon extensions"><p>Connect Suwayomi to view its extension catalog and install the sources you use on Android.</p><button className="btn" onClick={nav.openConnections}>Connect server</button></EmptyState>}
    <section className="settings-card"><div className="section-heading"><h3>Extension stores</h3><button className="text-btn" disabled={disabled} onClick={() => void run('refresh', () => refreshServerExtensions(connection.url), 'Extension catalog refreshed.')}><Icon name="refresh" size={16} />Refresh</button></div>
      {stores.map(store => <div className="source-review-row" key={store.indexUrl}><div><strong>{store.name}</strong><small className="extension-url">{store.indexUrl}</small></div><button className="text-btn danger" disabled={disabled} aria-label={`Remove ${store.name} store`} onClick={() => {
        if (window.confirm(`Remove ${store.name} from your server's extension stores? Installed sources and your library are kept.`)) void run(store.indexUrl, () => removeServerExtensionStore(store.indexUrl, connection.url), `Removed ${store.name} store.`);
      }}>Remove</button></div>)}
      {!!saved.length && <><h4>Stores from your Mihon backup</h4>{saved.map(store => <div className="source-review-row" key={store.indexUrl}><div><strong>{store.name}</strong><small>{connected ? 'Ready to add to your server' : 'Retained from Android'}</small></div><button className="btn-ghost outlined" disabled={disabled} aria-label={`Add ${store.name} store`} onClick={() => void run(store.indexUrl, () => addServerExtensionStore(store.indexUrl, connection.url), `Added ${store.name}. Its extensions are available below.`)}>Add store</button></div>)}</>}
      <form onSubmit={e => { e.preventDefault(); void run('add-store', async () => { await addServerExtensionStore(storeUrl.trim(), connection.url); setStoreUrl(''); }, 'Extension store added.'); }}>
        <label className="field-label">Add extension store<input type="url" aria-label="Extension store URL" placeholder="https://…/index.pb or repo.json" autoCapitalize="none" autoCorrect="off" value={storeUrl} onChange={e => setStoreUrl(e.target.value)} disabled={disabled} required /></label>
        <button className="btn-ghost outlined" disabled={disabled || !storeUrl.trim()}>Add store</button>
      </form>
      <p className="muted">Add the store URL from Mihon. Install only extensions from stores you trust.</p>
    </section>
    {connected && <section aria-label="Android extension catalog">
      <div className="section-heading"><h3>Extensions · {extensions.length}</h3><span>{extensions.filter(e => e.isInstalled).length} installed</span></div>
      <div className="searchbar"><Icon name="search" /><input type="search" aria-label="Search extensions" placeholder="Find a manga source" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <div className="browse-toolbar"><select aria-label="Extension language" value={lang} onChange={e => setLang(e.target.value)}><option value="all">All languages</option>{[...new Set(extensions.map(e => e.lang))].sort().map(language => <option key={language} value={language}>{language.toUpperCase()}</option>)}</select><select aria-label="Extension status" value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="all">All extensions</option><option value="installed">Installed</option><option value="available">Available</option><option value="updates">Updates</option></select></div>
      {loading && <div className="spinner" role="status" aria-label="Loading extension catalog" />}
      {visible.map(extension => <article className="extension-row" key={extension.pkgName} aria-label={`${extension.name} ${extension.lang.toUpperCase()} extension`}>
        <SourceLogo id={extension.pkgName} name={extension.name} /><div className="extension-info"><strong>{extension.name}</strong><small>{extension.lang.toUpperCase()} · v{extension.versionName}{extension.isNsfw ? ' · 18+' : ''}{extension.isObsolete ? ' · Unavailable' : ''}</small><small>{stores.find(s => s.indexUrl === extension.storeIndexUrl)?.name ?? extension.storeIndexUrl ?? 'Manually installed'}</small></div>
        <div className="extension-actions">{extension.isInstalled ? <>{extension.hasUpdate && !extension.isObsolete && <button className="btn-ghost outlined" disabled={disabled} onClick={() => void run(extension.pkgName, () => updateServerExtension(extension, 'update', connection.url), `Updated ${extension.name}.`)}>Update</button>}<button className="text-btn danger" disabled={disabled} onClick={() => {
          if (window.confirm(`Uninstall ${extension.name} from your server? Your library, progress and downloaded chapters are kept.`)) void run(extension.pkgName, () => updateServerExtension(extension, 'uninstall', connection.url), `Uninstalled ${extension.name}.`);
        }}>Uninstall</button></> : <button className="btn-ghost outlined" disabled={disabled || extension.isObsolete} onClick={() => void run(extension.pkgName, () => updateServerExtension(extension, 'install', connection.url), `Installed ${extension.name}. Its sources are now in Browse.`)}>{busy === extension.pkgName ? 'Installing…' : 'Install'}</button>}</div>
      </article>)}
      {!loading && !error && !visible.length && <EmptyState icon="search" title={extensions.length ? 'No matching extensions' : 'Add an extension store'}><p>{extensions.length ? 'Try another search, language or status.' : 'Add your Mihon stores above, then refresh the catalog.'}</p></EmptyState>}
    </section>}
  </div>;
}
