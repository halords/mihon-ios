import { useCallback, useEffect, useRef, useState } from 'react';
import { backupSourceConfigs } from '../sources/backupSources';
import { browserSourceEnabled, setBrowserSource } from '../lib/browserSources';
import { fetchWithTimeout } from '../lib/fetchJson';
import SourceLogo from './SourceLogo';

interface Snapshot { configured: boolean; image: string; width: number; height: number; title: string; url: string; requiresVerification: boolean }
export default function BrowserSourcesPanel() {
  const initial = new URLSearchParams(location.hash.split('?')[1]).get('source');
  const [sourceId, setSourceId] = useState(backupSourceConfigs.some(source => source.id === initial) ? initial! : backupSourceConfigs[0].id);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [enabled, setEnabled] = useState(() => browserSourceEnabled(sourceId));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [text, setText] = useState('');
  const generation = useRef(0), inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const source = backupSourceConfigs.find(source => source.id === sourceId)!;
  useEffect(() => {
    let active = true;
    void fetchWithTimeout('/api/source-browser?status=1').then(async response => {
      const result = await response.json() as { configured?: boolean; error?: string };
      if (active) { setConfigured(response.ok && !!result.configured); if (!response.ok) setError(result.error ?? 'Browser backend is unavailable'); }
    }).catch(error => { if (active) { setConfigured(false); setError(error instanceof Error ? error.message : 'Browser backend is unavailable'); } });
    return () => { active = false; generation.current++; controller.current?.abort(); };
  }, []);
  const update = useCallback(async (action?: Record<string, unknown>, silent = false) => {
    if (inFlight.current) return;
    const request = generation.current; inFlight.current = true;
    const abort = new AbortController(); controller.current = abort;
    if (!silent) { setBusy(true); setError(''); }
    try {
      const response = await fetchWithTimeout(`/api/source-browser?source=${encodeURIComponent(sourceId)}`, { ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) } : {}), signal: abort.signal }, 45000);
      const result = await response.json() as Snapshot & { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Browser verification failed');
      if (request === generation.current) { setSnapshot(result); setError(''); }
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : 'Browser verification failed'); }
    finally { if (controller.current === abort) { inFlight.current = false; controller.current = null; } if (request === generation.current) setBusy(false); }
  }, [sourceId]);
  useEffect(() => {
    if (!snapshot) return;
    const timer = setInterval(() => { if (!document.hidden) void update(undefined, true); }, 3000);
    return () => clearInterval(timer);
  }, [snapshot?.configured, update]);
  return <section className="settings-card browser-verification" aria-label="Browser verification">
    <h3>Browser verification</h3><p className="muted">Open a source in your server's browser. Complete website verification here, then use the same session for browsing and reading.</p>
    <label className="field-label">Source<select aria-label="Verification source" value={sourceId} onChange={event => { generation.current++; controller.current?.abort(); inFlight.current = false; setSourceId(event.target.value); setEnabled(browserSourceEnabled(event.target.value)); setSnapshot(null); setError(''); setBusy(false); }}>{backupSourceConfigs.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
    <div className="source-review-row"><SourceLogo id={sourceId} name={source.name} /><div><strong>{source.name}</strong><small>{configured === null ? 'Checking browser backend…' : configured ? 'Browser backend connected' : 'Browser backend needs setup'}</small></div></div>
    <label className="form-row">Use browser session for this source<input type="checkbox" checked={enabled} disabled={!configured && !enabled} onChange={event => { setBrowserSource(sourceId, event.target.checked); setEnabled(event.target.checked); }} /></label>
    {configured && <div className="button-row"><button className="btn" disabled={busy} onClick={() => void update({ type: 'open' })}>{busy ? 'Opening…' : 'Open source browser'}</button>{snapshot && <button className="btn-ghost outlined" disabled={busy} onClick={() => void update()}>Refresh view</button>}</div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {snapshot && <><p className="muted">{snapshot.requiresVerification ? 'Complete the website check in the view below.' : 'The source browser is open. You can enable this session and retry the source.'}</p><button type="button" className="browser-session-view" aria-label="Interact with source browser" onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      void update({ type: 'click', x: (event.clientX - rect.left) * snapshot.width / rect.width, y: (event.clientY - rect.top) * snapshot.height / rect.height });
    }}><img src={'data:image/jpeg;base64,' + snapshot.image} alt={snapshot.title || source.name + ' browser'} width={snapshot.width} height={snapshot.height} /></button>
      <div className="button-row"><button className="btn-ghost outlined" disabled={busy} onClick={() => void update({ type: 'scroll', y: -580 })}>Scroll up</button><button className="btn-ghost outlined" disabled={busy} onClick={() => void update({ type: 'scroll', y: 580 })}>Scroll down</button></div>
      <form className="browser-input" onSubmit={event => { event.preventDefault(); void update({ type: 'text', text }).then(() => setText('')); }}><input aria-label="Type in source browser" value={text} maxLength={256} placeholder="Type in the selected website field" onChange={event => setText(event.target.value)} /><button className="btn-ghost outlined" disabled={busy || !text}>Type</button><button type="button" className="btn-ghost outlined" disabled={busy} onClick={() => void update({ type: 'key', key: 'Enter' })}>Enter</button></form>
      <div className="button-row"><button className="btn" onClick={() => { setBrowserSource(sourceId, true); setEnabled(true); }}>Use this session</button><button className="text-btn" disabled={busy} onClick={() => void update({ type: 'reset' })}>Reset browser cookies</button></div>
    </>}
    <a className="text-btn" href="/help/browser-backend.html" target="_blank" rel="noopener noreferrer">Ubuntu VPS setup instructions</a>
  </section>;
}
