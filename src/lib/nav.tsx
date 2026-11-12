import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type TabId = 'library' | 'updates' | 'history' | 'browse' | 'more';
export type Route = { name: 'tabs' } | { name: 'details'; mangaKey: string } |
  { name: 'reader'; mangaKey: string; chapterId: string } | { name: 'settings' | 'extensions' | 'downloads' | 'backup' | 'categories' | 'connections' | 'account' } |
  { name: 'migrate'; mangaKey: string };
export interface Nav {
  tab: TabId; route: Route;
  setTab(tab: TabId): void; openManga(key: string): void; openReader(key: string, chapterId: string): void;
  openSettings(): void; openExtensions(): void; openDownloads(): void; openBackup(): void;
  openCategories(): void; openConnections(): void; openMigration(key: string): void; back(): void;
  openAccount(): void;
}
type NavigationState = { tab: TabId; route: Route };
const TABS: TabId[] = ['library', 'updates', 'history', 'browse', 'more'];

function readLocation(): NavigationState {
  const [path, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const selected = params.get('tab');
  const tab = TABS.includes(selected as TabId) ? selected as TabId : 'library';
  const key = params.get('manga');
  const chapterId = params.get('chapter');
  if (path === '/reader' && key?.includes('::') && chapterId) return { tab, route: { name: 'reader', mangaKey: key, chapterId } };
  if (path === '/details' && key?.includes('::')) return { tab, route: { name: 'details', mangaKey: key } };
  if (path === '/migrate' && key?.includes('::')) return { tab, route: { name: 'migrate', mangaKey: key } };
  const name = path?.slice(1);
  if (['settings', 'extensions', 'downloads', 'backup', 'categories', 'connections', 'account'].includes(name ?? '')) {
    return { tab, route: { name: name as 'settings' } };
  }
  return { tab: TABS.includes(name as TabId) ? name as TabId : tab, route: { name: 'tabs' } };
}
function hashFor(state: NavigationState): string {
  if (state.route.name === 'tabs') return `#/${state.tab}`;
  const params = new URLSearchParams({ tab: state.tab });
  if ('mangaKey' in state.route) params.set('manga', state.route.mangaKey);
  if (state.route.name === 'reader') params.set('chapter', state.route.chapterId);
  return `#/${state.route.name}?${params}`;
}
export const NavContext = createContext<Nav | null>(null);
export function NavProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(readLocation);
  useEffect(() => {
    if (!history.state?.mihon) history.replaceState({ mihon: true, depth: 0 }, '', hashFor(state));
    const sync = () => {
      setState(readLocation());
      requestAnimationFrame(() => window.scrollTo(0, Number(history.state?.scrollY) || 0));
    };
    window.addEventListener('popstate', sync); window.addEventListener('hashchange', sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync); };
  }, []);
  function go(route: Route, tab = state.tab, replace = false): void {
    const next = { tab, route };
    const previous = history.state ?? {};
    history.replaceState({ ...previous, scrollY: window.scrollY }, '');
    const value = { mihon: true, depth: replace ? previous.depth ?? 0 : (previous.depth ?? 0) + 1,
      from: replace ? previous.from : state.route.name, scrollY: 0 };
    if (replace) history.replaceState(value, '', hashFor(next)); else history.pushState(value, '', hashFor(next));
    setState(next);
    window.scrollTo(0, 0);
  }
  const nav: Nav = {
    ...state,
    setTab: tab => go({ name: 'tabs' }, tab),
    openManga: mangaKey => {
      if (state.route.name === 'reader' && state.route.mangaKey === mangaKey && history.state?.from === 'details' && history.state?.depth > 0) history.back();
      else go({ name: 'details', mangaKey }, state.tab, state.route.name === 'reader');
    },
    openReader: (mangaKey, chapterId) => {
      go({ name: 'reader', mangaKey, chapterId }, state.tab, state.route.name === 'reader');
    },
    openSettings: () => go({ name: 'settings' }), openExtensions: () => go({ name: 'extensions' }),
    openDownloads: () => go({ name: 'downloads' }), openBackup: () => go({ name: 'backup' }),
    openCategories: () => go({ name: 'categories' }), openConnections: () => go({ name: 'connections' }),
    openAccount: () => go({ name: 'account' }),
    openMigration: mangaKey => go({ name: 'migrate', mangaKey }),
    back() {
      if (state.route.name === 'reader' && history.state?.from !== 'details') go({ name: 'details', mangaKey: state.route.mangaKey }, state.tab, true);
      else if ((history.state?.depth ?? 0) > 0) history.back();
      else go({ name: 'tabs' }, state.tab, true);
    },
  };
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}
export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('Navigation is unavailable');
  return nav;
}
