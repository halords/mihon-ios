import { useState } from 'react';
import { useNav } from '../lib/nav';
import Icon from '../components/Icon';
import AndroidExtensionsPanel from '../components/AndroidExtensionsPanel';
import WebExtensionsPanel from '../components/WebExtensionsPanel';

export function ExtensionPanels() {
  const [kind, setKind] = useState<'android' | 'web'>('android');
  return <>
    <div className="seg" aria-label="Extension type"><button aria-pressed={kind === 'android'} onClick={() => setKind('android')}>Mihon extensions</button><button aria-pressed={kind === 'web'} onClick={() => setKind('web')}>Web extensions</button></div>
    {kind === 'android' ? <AndroidExtensionsPanel /> : <WebExtensionsPanel />}
  </>;
}

export default function ExtensionsPage() {
  const nav = useNav();
  return <main className="screen"><header className="topbar"><button className="icon-btn" aria-label="Back" onClick={nav.back}><Icon name="back" /></button><h1>Extensions</h1></header><ExtensionPanels /></main>;
}
