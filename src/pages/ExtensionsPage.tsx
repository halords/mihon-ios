import { useState } from 'react';
import { useNav } from '../lib/nav';
import Icon from '../components/Icon';
import AndroidExtensionsPanel from '../components/AndroidExtensionsPanel';
import WebExtensionsPanel from '../components/WebExtensionsPanel';
import { useSources } from '../lib/hooks';
import SourceLogo from '../components/SourceLogo';

export function ExtensionPanels() {
  const [kind, setKind] = useState<'builtin' | 'android' | 'web'>('builtin');
  const sources = useSources();
  return <>
    <div className="seg" aria-label="Extension type"><button aria-pressed={kind === 'builtin'} onClick={() => setKind('builtin')}>Built-in sources</button><button aria-pressed={kind === 'android'} onClick={() => setKind('android')}>Mihon extensions</button><button aria-pressed={kind === 'web'} onClick={() => setKind('web')}>Web extensions</button></div>
    {kind === 'builtin' ? <section className="settings-card"><h3>Your backup sources</h3><p className="muted">These sources are integrated into the app. Open Browse → Sources to use them. They require an internet connection for browsing and downloads. Saved chapters stay available offline.</p>{sources.filter(source => source.kind === 'builtin').map(source => <div className="source-review-row" key={source.id}><SourceLogo id={source.id} name={source.name} iconUrl={source.iconUrl} /><div><strong>{source.name}</strong><small>{source.lang?.toUpperCase()} · Included in app</small></div><span className="chip success-chip">Built in</span></div>)}<a className="text-btn" href="/help/sources.html" target="_blank" rel="noopener noreferrer">Source help and availability</a></section> : kind === 'android' ? <AndroidExtensionsPanel /> : <WebExtensionsPanel />}
  </>;
}

export default function ExtensionsPage() {
  const nav = useNav();
  return <main className="screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Extensions</h1></header><ExtensionPanels /></main>;
}
