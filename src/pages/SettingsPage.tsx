import { useEffect, useState } from 'react';
import { useNav } from '../lib/nav';
import { useSettings } from '../lib/hooks';
import { saveSettings, type ReaderMode } from '../lib/settings';
import { clearPagesCache } from '../lib/downloads';
import { clearDownloadQueue, setDownloadsPaused } from '../lib/downloadQueue';
import { formatBytes } from '../lib/files';
import Icon from '../components/Icon';
import { toast } from '../components/Feedback';

export default function SettingsPage() {
  const nav = useNav();
  const settings = useSettings();
  const [proxy, setProxy] = useState(settings.proxyBase);
  const [languages, setLanguages] = useState(settings.chapterLanguages.join(', '));
  const [storage, setStorage] = useState({ usage: 0, quota: 0, persistent: false });
  const [busy, setBusy] = useState(false);
  async function refreshStorage() {
    try { const estimate = await navigator.storage?.estimate?.(); const persistent = await navigator.storage?.persisted?.() ?? false; setStorage({ usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0, persistent }); }
    catch { /* storage stats are optional */ }
  }
  useEffect(() => { void refreshStorage(); }, []);
  return <main className="screen settings-screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Settings</h1></header>
    <section className="settings-card"><div className="card-heading"><Icon name="library" /><h3>Reader</h3></div>
      <label className="form-row">Default reading mode<select value={settings.readerMode} onChange={e => saveSettings({ readerMode: e.target.value as ReaderMode })}><option value="vertical">Webtoon / vertical</option><option value="paged">Left to right</option><option value="rtl">Right to left</option></select></label>
      <label className="form-row">Paged image fit<select value={settings.readerFit} onChange={e => saveSettings({ readerFit: e.target.value as 'width' | 'screen' })}><option value="screen">Fit screen</option><option value="width">Fit width</option></select></label>
      <label className="form-row">Continuous chapters<input type="checkbox" checked={settings.continuousReading} onChange={e => saveSettings({ continuousReading: e.target.checked })} /></label>
      <p className="muted">A title’s imported reading mode takes precedence. Change it from the reader’s controls.</p>
    </section>
    <section className="settings-card"><div className="card-heading"><Icon name="grid" /><h3>Library & appearance</h3></div>
      <label className="form-row">Theme<select value={settings.theme} onChange={e => saveSettings({ theme: e.target.value as 'dark' | 'light' })}><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <label className="form-row">Library display<select value={settings.libraryView} onChange={e => saveSettings({ libraryView: e.target.value as 'grid' | 'list' })}><option value="grid">Cover grid</option><option value="list">List</option></select></label>
      <label className="form-row">Downloaded titles only<input type="checkbox" checked={settings.downloadedOnly} onChange={e => saveSettings({ downloadedOnly: e.target.checked })} /></label>
      <button className="sheet-option" onClick={nav.openCategories}><Icon name="folder" />Manage categories<Icon name="chevron" size={18} /></button>
    </section>
    <section className="settings-card"><div className="card-heading"><Icon name="cloud" /><h3>Sources & network</h3></div><button className="sheet-option" onClick={nav.openConnections}><Icon name="cloud" />Android source connection<Icon name="chevron" size={18} /></button>
      <label className="form-row">MangaDex data saver<input type="checkbox" checked={settings.dataSaver} onChange={e => saveSettings({ dataSaver: e.target.checked })} /></label><p className="muted">Smaller chapter images use less mobile data and device storage.</p>
      <label className="field-label">MangaDex chapter languages<input value={languages} placeholder="en, es, fr, pt-br" onChange={e => setLanguages(e.target.value)} /></label>
      <button className="text-btn" onClick={() => { const values = languages.split(',').map(v => v.trim().toLowerCase()).filter(v => /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(v)); if (!values.length) toast('Enter language codes such as en, es, or pt-br'); else { saveSettings({ chapterLanguages: values }); toast('Chapter languages saved'); } }}>Save languages</button>
      <label className="field-label">Custom CORS proxy (optional)<input type="text" autoCapitalize="none" autoCorrect="off" value={proxy} placeholder="https://your-proxy.example/?url=" onChange={e => setProxy(e.target.value)} /></label>
      <p className="muted">MangaDex uses the included proxy by default. A custom proxy can use a URL prefix, ?url=, or a {'{url}'} placeholder.</p><button className="text-btn" onClick={() => {
        try { if (proxy.trim()) { const url = new URL(proxy.trim()); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); } saveSettings({ proxyBase: proxy.trim() }); toast('Proxy saved'); }
        catch { toast('Enter a valid HTTP or HTTPS proxy URL'); }
      }}>Save proxy</button>
    </section>
    <section className="settings-card"><div className="card-heading"><Icon name="download" /><h3>Device storage</h3></div><div className="form-row"><span>Storage used</span><span>{formatBytes(storage.usage)}</span></div>{storage.quota > 0 && <><div className="download-progress"><span style={{ width: `${Math.min(100, storage.usage / storage.quota * 100)}%` }} /></div><p className="muted">{formatBytes(storage.quota)} allocated by the browser</p></>}
      <div className="form-row"><span>Persistent storage</span>{storage.persistent ? <span className="chip success-chip">Granted</span> : <button className="text-btn" disabled={!navigator.storage?.persist} onClick={() => void navigator.storage.persist().then(granted => { toast(granted ? 'Persistent storage granted' : 'This browser did not grant persistent storage'); void refreshStorage(); }).catch(() => toast('Persistent storage is unavailable'))}>Request</button>}</div>
      <button className="sheet-option" onClick={nav.openDownloads}><Icon name="download" />Manage downloads<Icon name="chevron" size={18} /></button>
      <label className="form-row">Delete chapters after reading<input type="checkbox" checked={settings.deleteReadDownloads} onChange={e => saveSettings({ deleteReadDownloads: e.target.checked })} /></label>
      <label className="form-row">Calm downloads (cooler, slower)<input type="checkbox" checked={settings.calmDownloads} onChange={e => saveSettings({ calmDownloads: e.target.checked })} /></label>
      <p className="muted">Like Mihon: once you finish a downloaded chapter, its pages are deleted to free storage. Your place and history are kept, and you can download it again anytime.</p>
      <button className="sheet-option danger" disabled={busy} onClick={() => {
        if (!window.confirm('Delete all downloaded chapter images and queued downloads? Library, bookmarks, and reading progress are kept.')) return;
        setBusy(true); void (async () => { await clearDownloadQueue(); await clearPagesCache(); await setDownloadsPaused(false); await refreshStorage(); toast('All chapter downloads deleted'); })().catch(error => toast(error instanceof Error ? error.message : 'Unable to clear downloads')).finally(() => setBusy(false));
      }}><Icon name="trash" />Delete all chapter downloads</button>
    </section>
    <section className="settings-card"><div className="card-heading"><Icon name="backup" /><h3>Backup & restore</h3></div><p className="muted">Keep a library backup before changing devices. Original Mihon backups are retained on this device and included in PWA library exports.</p><button className="btn wide" onClick={nav.openBackup}>Open backup & restore</button></section>
    <section className="settings-card"><h3>Install on iPhone or iPad</h3><p className="muted">Open this app in Safari over HTTPS. Choose Share → Add to Home Screen, then launch it from your home screen. The installed app and downloaded chapters open offline.</p></section>
    <p className="settings-footnote">Mihon PWA · 0.2.0<br />Library and reading progress stay on this device. Source requests use your selected sources and server.</p>
  </main>;
}
