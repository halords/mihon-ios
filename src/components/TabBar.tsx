import { useNav, type TabId } from '../lib/nav';
import Icon, { type IconName } from './Icon';

const tabs: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'library', label: 'Library', icon: 'library' }, { id: 'updates', label: 'Updates', icon: 'refresh' },
  { id: 'history', label: 'History', icon: 'history' }, { id: 'browse', label: 'Browse', icon: 'browse' }, { id: 'more', label: 'More', icon: 'more' },
];
export default function TabBar() {
  const nav = useNav();
  return <nav className="tabbar" aria-label="Main navigation">{tabs.map(tab => <button key={tab.id} className={nav.tab === tab.id ? 'active' : ''} aria-current={nav.tab === tab.id ? 'page' : undefined} onClick={() => nav.setTab(tab.id)}><span className="nav-icon"><Icon name={tab.icon} size={23} /></span><span>{tab.label}</span></button>)}</nav>;
}
