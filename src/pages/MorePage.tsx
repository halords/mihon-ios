import { useNav } from '../lib/nav';
import { useConnection, useOnline, useQueue, useSettings } from '../lib/hooks';
import { saveSettings } from '../lib/settings';
import Icon from '../components/Icon';
import { useAccount } from '../lib/account';

export default function MorePage() {
  const nav = useNav();
  const settings = useSettings();
  const queue = useQueue();
  const connection = useConnection();
  const online = useOnline();
  const account = useAccount();
  return <main className="screen settings-screen"><header className="topbar"><h1>More</h1></header>
    <div className="app-identity"><img src="/icons/icon-192.png" alt="" width={62} height={62} /><div><h2>Mihon</h2><p>Your library, wherever you read.</p><small>PWA for iPhone & iPad</small></div></div>
    <section className="settings-card"><label className="more-switch"><span className="more-icon"><Icon name="download" /></span><span><strong>Downloaded only</strong><small>Show titles available on this device</small></span><input type="checkbox" checked={settings.downloadedOnly} onChange={e => saveSettings({ downloadedOnly: e.target.checked })} /></label></section>
    <section className="settings-card more-menu">{[
      { icon: 'account', title: 'Account & sync', detail: account.user ? account.status === 'offline' ? 'Offline changes will sync when connected' : account.user.email : 'Keep your library across devices', action: nav.openAccount },
      { icon: 'download', title: 'Downloads', detail: queue.jobs.length ? `${queue.jobs.length} chapters in queue` : 'Your offline shelf', action: nav.openDownloads },
      { icon: 'backup', title: 'Backup & restore', detail: 'Import Mihon, export your library', action: nav.openBackup },
      { icon: 'folder', title: 'Categories', detail: 'Organize titles into multiple shelves', action: nav.openCategories },
    ].map(item => <button className="more-row" key={item.title} onClick={item.action}><span className="more-icon"><Icon name={item.icon as 'download'} /></span><span><strong>{item.title}</strong><small>{item.detail}</small></span><Icon name="chevron" size={18} /></button>)}</section>
    <section className="settings-card more-menu">{[
      { icon: 'cloud', title: 'Connections', detail: connection.status === 'connected' ? `${connection.sources.length} Android sources connected` : 'Use Android extensions through Suwayomi', action: nav.openConnections },
      { icon: 'browse', title: 'Web extensions', detail: 'Install browser source adapters', action: nav.openExtensions },
      { icon: 'settings', title: 'Settings', detail: 'Reader, appearance, and storage', action: nav.openSettings },
    ].map(item => <button className="more-row" key={item.title} onClick={item.action}><span className="more-icon"><Icon name={item.icon as 'cloud'} /></span><span><strong>{item.title}</strong><small>{item.detail}</small></span><Icon name="chevron" size={18} /></button>)}</section>
    <div className="more-status"><span className={`status-dot ${online ? 'online' : ''}`} />{online ? 'Online' : 'Offline · downloaded chapters are ready'}<span>v0.2.0</span></div>
    <p className="settings-footnote">Inspired by the open source Mihon Android app.<br />{account.user ? 'Your library is saved here and synced with your account.' : 'Your library is saved on this device. Sign in to sync it.'}</p>
  </main>;
}
