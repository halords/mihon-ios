import { useState } from 'react';
import { connectSuwayomi, sendBackupToServer, setBackendAuth } from '../lib/suwayomi';
import { useConnection, useDataEvents, useSettings } from '../lib/hooks';
import { getAllManga, getArchives, getLibrary } from '../lib/db';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import { getSource } from '../sources';
import { formatBytes } from '../lib/files';
import Icon from '../components/Icon';
import SourceLogo from '../components/SourceLogo';
import BrowserSourcesPanel from '../components/BrowserSourcesPanel';

export default function ConnectionsPage() {
  const nav = useNav();
  const settings = useSettings();
  const connection = useConnection();
  const [url, setUrl] = useState(settings.suwayomiUrl);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const { data, reload } = useLoad(async () => {
    const [archives, manga, library] = await Promise.all([getArchives(), getAllManga(), getLibrary()]);
    const keys = new Set(library.map(m => m.key));
    const imported = new Map<string, { id: string; name: string; count: number }>();
    for (const m of manga.filter(m => keys.has(m.key))) {
      const source = imported.get(m.manga.sourceId) ?? { id: m.manga.sourceId, name: m.manga.sourceName ?? getSource(m.manga.sourceId)?.name ?? m.manga.sourceId, count: 0 };
      source.count++; imported.set(source.id, source);
    }
    return { archives, imported: [...imported.values()].sort((a, b) => b.count - a.count) };
  }, []);
  useDataEvents(reload);
  async function connect(base = url) {
    setBusy(true); setError(''); setMessage('Connecting…');
    try { if (username) setBackendAuth(username, password); const sources = await connectSuwayomi(base); setUrl(base); setMessage(`${sources.length} Android sources connected`); }
    catch (error) { setError(error instanceof Error ? error.message : 'Connection failed'); setMessage(''); }
    finally { setBusy(false); }
  }
  return <main className="screen settings-screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Connections</h1></header>
    <div className="page-intro"><h2>Your sources, on iOS.</h2><p>Your backup sources are built in. Use browser verification for websites that require a browser session, or connect Suwayomi for Android extensions.</p></div>
    <BrowserSourcesPanel />
    {error && <div className="error" role="alert">{error}</div>}{message && <p className="status-message" role="status">{message}</p>}
    <section className="settings-card"><div className="card-heading"><Icon name="cloud" /><h3>Suwayomi server</h3><span className={`chip ${connection.status === 'connected' ? 'success-chip' : ''}`}>{connection.status === 'connected' ? 'Connected' : connection.status === 'connecting' ? 'Connecting' : connection.status === 'offline' ? 'Offline' : 'Disconnected'}</span></div>
      <label className="field-label">Server URL<input type="url" aria-label="Suwayomi server URL" autoCapitalize="none" autoCorrect="off" placeholder="https://suwayomi.example.com" value={url} onChange={e => setUrl(e.target.value)} /></label>
      <details className="authentication"><summary>Authentication (optional)</summary><label className="field-label">Username<input value={username} autoComplete="username" onChange={e => setUsername(e.target.value)} /></label><label className="field-label">Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><p className="muted">Enter your server’s Basic authentication credentials. They are kept for this browser session. Use the bundled connection when uploading backups to an authenticated server.</p></details>
      <div className="button-row"><button className="btn" disabled={busy || !url.trim()} onClick={() => void connect()}>{busy ? 'Working…' : connection.status === 'connected' ? 'Refresh sources' : 'Connect'}</button><button className="btn-ghost outlined" disabled={busy} onClick={() => { setUrl('/api/suwayomi'); void connect('/api/suwayomi'); }}>Use bundled server</button></div>
      {settings.suwayomiUrl && <button className="text-btn danger" disabled={busy} onClick={() => { setBackendAuth('', ''); void connectSuwayomi('').then(() => { setUrl(''); setMessage('Disconnected. Your library and downloads are kept.'); }).catch(error => setError(error instanceof Error ? error.message : 'Disconnect failed')); }}>Disconnect</button>}
      {(connection.error && !error) && <p className="inline-error" role="alert">{connection.error}</p>}
      <p className="muted">Manage Mihon extensions from Browse → Extensions. Use an HTTPS server URL for an installed iPhone PWA, or the included server proxy.</p>
      <button className="text-btn" onClick={nav.openExtensions}>Manage Mihon extensions <Icon name="arrow" size={16} /></button>
      {/^https?:\/\//.test(url) && <a className="text-btn" href={url} target="_blank" rel="noopener noreferrer">Open Suwayomi <Icon name="arrow" size={16} /></a>}
    </section>
    {!!data?.archives.length && <section className="settings-card"><h3>Connect imported library URLs</h3><p className="muted">Copy a retained Mihon backup to your configured Suwayomi server. It gives the Android extensions the original manga and chapter URLs to resolve.</p>{data.archives.map(archive => <div className="archive-row" key={archive.id}><div><strong>{archive.name}</strong><small>{archive.mangaCount} titles · {formatBytes(archive.bytes.size)}</small></div><button className="btn-ghost outlined" disabled={busy || connection.status !== 'connected'} onClick={() => {
      if (!window.confirm('Copy this backup to your configured Suwayomi server and merge it into the server library?')) return;
      setBusy(true); setError(''); setMessage('Sending backup to your server…');
      void sendBackupToServer(archive, setMessage).then(() => { setMessage('Server library restored. Android sources can now resolve your titles.'); reload(); }).catch(error => { setError(error instanceof Error ? error.message : 'Server restore failed'); setMessage(''); }).finally(() => setBusy(false));
    }}>Copy to server</button></div>)}</section>}
    {!!data?.imported.length && <section className="settings-card"><h3>Sources used by your library</h3>{data.imported.map(source => <div className="source-review-row" key={source.id}><SourceLogo id={source.id} name={source.name} /><div><strong>{source.name}</strong><small>{source.count} titles</small></div><span className={`chip ${getSource(source.id) || source.id === 'local' ? 'success-chip' : ''}`}>{source.id === 'local' ? 'On device' : source.id === '0' ? 'Import CBZ files' : getSource(source.id) ? 'Available' : 'Needs extension'}</span></div>)}</section>}
    {!!connection.sources.length && <section className="settings-card"><h3>Connected Android sources · {connection.sources.length}</h3><div className="searchbar"><Icon name="search" /><input type="search" aria-label="Filter connected sources" placeholder="Find a source" value={query} onChange={e => setQuery(e.target.value)} /></div>{connection.sources.filter(s => `${s.name} ${s.lang}`.toLowerCase().includes(query.toLowerCase())).map(source => <div className="source-review-row" key={source.id}><SourceLogo id={source.id} name={source.name} /><div><strong>{source.name}</strong><small>{source.lang.toUpperCase()} · {source.id}</small></div><Icon name="check" size={18} /></div>)}</section>}
    <section className="settings-card"><h3>Connect your Mihon sources</h3><ol><li>Start Suwayomi on your computer or server and connect here.</li><li>Open Browse → Extensions, add your retained Mihon stores, and install matching sources.</li><li>Copy your retained Mihon backup to the server.</li><li>Open a title and download its chapters for offline reading.</li></ol><a className="text-btn" href="/help/suwayomi.html" target="_blank" rel="noopener noreferrer">Server setup instructions <Icon name="arrow" size={16} /></a></section>
    <section className="settings-card"><h3>Web extensions</h3><p className="muted">Browser source adapters can also be installed from web extension indexes.</p><button className="text-btn" onClick={nav.openExtensions}>Manage web extensions <Icon name="arrow" size={16} /></button></section>
  </main>;
}
