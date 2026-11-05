import { createContext, useContext, useState, type ReactNode } from 'react';

export type TabId = 'library' | 'updates' | 'history' | 'browse' | 'more';

export type Route =
  | { name: 'tabs' }
  | { name: 'details'; mangaKey: string }
  | { name: 'reader'; mangaKey: string; chapterId: string }
  | { name: 'settings' };

export interface Nav {
  tab: TabId;
  route: Route;
  setTab(t: TabId): void;
  openManga(mangaKey: string): void;
  openReader(mangaKey: string, chapterId: string): void;
  openSettings(): void;
  back(): void;
}

interface NavigationState {
  tab: TabId;
  route: Route;
  lastDetailsMangaKey: string | null;
}

export const NavContext = createContext<Nav | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NavigationState>({
    tab: 'library',
    route: { name: 'tabs' },
    lastDetailsMangaKey: null,
  });

  const nav: Nav = {
    tab: state.tab,
    route: state.route,

    setTab(tab) {
      setState((previous) => ({
        ...previous,
        tab,
        route: { name: 'tabs' },
      }));
    },

    openManga(mangaKey) {
      setState((previous) => ({
        ...previous,
        route: { name: 'details', mangaKey },
        lastDetailsMangaKey: mangaKey,
      }));
    },

    openReader(mangaKey, chapterId) {
      setState((previous) => ({
        ...previous,
        route: { name: 'reader', mangaKey, chapterId },
        // Direct reader navigation must also return to this manga's details.
        lastDetailsMangaKey: mangaKey,
      }));
    },

    openSettings() {
      setState((previous) => ({
        ...previous,
        route: { name: 'settings' },
      }));
    },

    back() {
      setState((previous) => {
        switch (previous.route.name) {
          case 'reader':
            return {
              ...previous,
              route: {
                name: 'details',
                mangaKey:
                  previous.lastDetailsMangaKey ?? previous.route.mangaKey,
              },
            };

          case 'details':
            return {
              ...previous,
              route: { name: 'tabs' },
            };

          case 'settings':
            return {
              ...previous,
              tab: 'more',
              route: { name: 'tabs' },
            };

          case 'tabs':
            return previous;
        }
      });
    },
  };

  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const nav = useContext(NavContext);

  if (nav === null) {
    throw new Error('useNav must be used within a NavProvider.');
  }

  return nav;
}
