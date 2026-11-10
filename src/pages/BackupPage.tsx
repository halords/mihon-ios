import { useState, type ChangeEvent } from 'react';
import { inspectTachibkFile, restoreTachibk, type TachibkPreview, type TachibkImportResult } from '../backup/tachibk';
import { exportData, getAllManga, getArchives, getLibrary, importData, validateBackupData, type BackupData } from '../lib/db';
import { useLoad } from '../lib/useLoad';
import { useNav } from '../lib/nav';
import { importCbz } from '../lib/localFiles';
import { formatBytes, saveFile } from '../lib/files';
import Icon from '../components/Icon';
import { toast } from '../components/Feedback';
import { initPlugins } from '../lib/plugins';
import { initSuwayomi } from '../lib/suwayomi';

export default function BackupPage() {
  const nav = useNav();
  const { data, reload } = useLoad(async () => {
    const [archives, mangas, library] = await Promise.all([getArchives(), getAllManga(), getLibrary()]);
    const keys = new Set(library.map(m => m.key));
    return { archives: archives.sort((a, b) => b.importedAt - a.importedAt), mangas: mangas.filter(m => keys.has(m.key)) };
  }, []);
  const [preview, setPreview] = useState<TachibkPreview | null>(null);
  const [jsonPreview, setJsonPreview] = useState<{ name: string; data: BackupData } | null>(null);
  const [result, setResult] = useState<TachibkImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [preferences, setPreferences] = useState(true);
  const [restorePlugins, setRestorePlugins] = useState(false);
  const [cbzTitle, setCbzTitle] = useState('');
  const [destination, setDestination] = useState('');
  async function chooseBackup(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || busy) return;
    setBusy(true); setError(''); setMessage('Reading backup…'); setPreview(null); setJsonPreview(null); setResult(null);
    try {
      if (file.name.toLowerCase().endsWith('.json')) setJsonPreview({ name: file.name, data: validateBackupData(JSON.parse(await file.text())) });
      else setPreview(await inspectTachibkFile(file));
      setMessage('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to read this backup'); setMessage(''); }
    finally { setBusy(false); }
  }
  async function restore(): Promise<void> {
    setBusy(true); setError('');
    try {
      if (preview) { setResult(await restoreTachibk(preview, { restorePreferences: preferences, onProgress: (done, total) => setMessage(`Restoring ${done} / ${total} titles…`) })); setPreview(null); }
      else if (jsonPreview) { await importData(jsonPreview.data, restorePlugins); if (restorePlugins) await initPlugins(); await initSuwayomi(); setJsonPreview(null); }
      setMessage('Library restored. Your existing reading progress was preserved.'); reload();
    } catch (error) { setError(error instanceof Error ? error.message : 'Restore failed'); setMessage(''); }
    finally { setBusy(false); }
  }
  async function exportLibrary(): Promise<void> {
    setBusy(true); setError('');
    try { saveFile(new Blob([JSON.stringify(await exportData())], { type: 'application/json' }), `mihon-pwa-${new Date().toISOString().slice(0, 10)}.json`); toast('Library backup exported'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Export failed'); }
    finally { setBusy(false); }
  }
  async function chooseCbz(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = [...event.target.files ?? []]; event.target.value = '';
    if (!files.length || busy) return;
    setBusy(true); setError('');
    let imported = 0; let pages = 0;
    const failures: string[] = [];
    for (const [i, file] of files.entries()) {
      setMessage(`Importing ${i + 1} / ${files.length} chapter files…`);
      try { const result = await importCbz(file, cbzTitle, destination || undefined); imported++; pages += result.pageCount; }
      catch (error) { failures.push(`${file.name}: ${error instanceof Error ? error.message : 'Import failed'}`); }
    }
    setMessage(`${imported} chapter files imported · ${pages} pages available offline`); setError(failures.join(' · ')); setBusy(false); reload();
  }
  return <main className="screen settings-screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Backup & restore</h1></header>
    <div className="page-intro"><h2>Bring your library with you.</h2><p>Restore a Mihon backup, keep your progress, and connect your sources when you’re ready.</p></div>
    {error && <div className="error" role="alert">{error}</div>}{message && <p className="status-message" role="status">{message}</p>}
    <section className="settings-card"><div className="card-heading"><Icon name="backup" /><h3>Restore a backup</h3></div><p className="muted">Choose a Mihon .tachibk backup or a PWA library .json file. Restores merge with your existing library.</p>
      <label className={`btn wide file-button ${busy ? 'disabled' : ''}`}><Icon name="plus" size={18} />Choose backup<input type="file" aria-label="Choose backup file" accept=".tachibk,.gz,.json,application/gzip,application/json" disabled={busy} onChange={e => void chooseBackup(e)} /></label>
    </section>
    {preview && <section className="settings-card backup-review"><div className="card-heading"><Icon name="check" /><h3>Review Mihon backup</h3></div><p className="filename">{preview.name} · {formatBytes(preview.file.size)}</p>
      <div className="backup-stats">{[[preview.libraryCount, 'Library titles'], [preview.chapterCount, 'Chapters'], [preview.readCount, 'Read chapters'], [preview.bookmarkCount, 'Bookmarks'], [preview.backup.categories.length, 'Categories'], [preview.historyCount, 'History entries']].map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
      <h4>Sources in this backup</h4>{preview.sources.map(source => <div className="source-review-row" key={source.id}><div><strong>{source.name}</strong><small>{source.mangaCount} titles</small></div><span className={`chip ${source.available ? 'success-chip' : ''}`}>{source.available ? 'Ready' : 'Connect after restore'}</span></div>)}
      <label className="form-row">Restore matching reader preferences<input type="checkbox" checked={preferences} onChange={e => setPreferences(e.target.checked)} /></label>
      <p className="muted">All categories, bookmarks, progress, history, notes, tracking records, and Android preferences are retained. A copy of the original file stays on this device. Chapter images need to be downloaded or imported separately.</p>
      <button className="btn wide" disabled={busy} onClick={() => void restore()}>{busy ? 'Restoring…' : `Restore ${preview.libraryCount} library titles`}</button><button className="text-btn" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
    </section>}
    {jsonPreview && <section className="settings-card backup-review"><h3>Review PWA backup</h3><p className="filename">{jsonPreview.name}</p><p>{jsonPreview.data.library.length} library titles · {jsonPreview.data.chapterMeta.length} chapters · {jsonPreview.data.history.length} history entries</p>{!!jsonPreview.data.plugins?.length && <label className="form-row">Restore included web extensions<input type="checkbox" checked={restorePlugins} onChange={e => setRestorePlugins(e.target.checked)} /></label>}<p className="muted">Reading state, categories, settings, and original Mihon archives are restored. Chapter images are separate CBZ files.</p><button className="btn wide" disabled={busy} onClick={() => void restore()}>Restore library</button><button className="text-btn" disabled={busy} onClick={() => setJsonPreview(null)}>Cancel</button></section>}
    {result && <section className="settings-card restore-result"><Icon name="check" size={34} /><h3>{result.libraryCount} titles restored</h3><p>{result.chapterCount} chapters · {result.bookmarkCount} bookmarks · {result.historyCount} history entries</p>{result.unavailableCount > 0 && <p>{result.unavailableCount} titles need a source connection. Suwayomi can run their Android extensions.</p>}<div className="button-row"><button className="btn" onClick={() => nav.setTab('library')}>Open library</button>{result.unavailableCount > 0 && <button className="btn-ghost" onClick={nav.openConnections}>Connect sources</button>}</div></section>}
    <section className="settings-card"><div className="card-heading"><Icon name="download" /><h3>Save your library</h3></div><p className="muted">Export library metadata, reading state, categories, settings, and retained Mihon files. Export chapter images as CBZ from Downloads.</p><button className="btn-ghost outlined wide" disabled={busy} onClick={() => void exportLibrary()}>Export PWA library (.json)</button></section>
    <section className="settings-card"><div className="card-heading"><Icon name="folder" /><h3>Import offline chapters</h3></div><p className="muted">Copy your Android downloads as CBZ/ZIP files. Put each chapter’s numbered images in its own ZIP. Select an existing title to retain its reading progress.</p>
      <label className="field-label">Destination<select aria-label="Chapter import destination" value={destination} onChange={e => setDestination(e.target.value)}><option value="">Create a local title</option>{data?.mangas.map(m => <option key={m.key} value={m.key}>{m.manga.title}</option>)}</select></label>
      {!destination && <label className="field-label">Series title<input type="text" placeholder="Use one title to group chapter files" value={cbzTitle} onChange={e => setCbzTitle(e.target.value)} /></label>}
      <label className={`btn-ghost outlined wide file-button ${busy ? 'disabled' : ''}`}>Choose CBZ chapter files<input type="file" aria-label="Import CBZ chapter files" accept=".cbz,.zip" multiple disabled={busy} onChange={e => void chooseCbz(e)} /></label>
    </section>
    {!!data?.archives.length && <section className="settings-card"><h3>Original Mihon backups</h3><p className="muted">The original bytes are retained, including fields that have no web equivalent.</p>{data.archives.map(archive => <div className="archive-row" key={archive.id}><div><strong>{archive.name}</strong><small>{archive.mangaCount} titles · {formatBytes(archive.bytes.size)}</small></div><button className="icon-btn" aria-label={`Download original ${archive.name}`} onClick={() => saveFile(archive.bytes, archive.name)}><Icon name="download" /></button></div>)}</section>}
  </main>;
}
