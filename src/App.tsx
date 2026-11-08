import { useEffect, useState } from 'react';
import { NavProvider, useNav } from './lib/nav';
import {
  applyTheme,
  loadSettings,
  onSettingsChange,
} from './lib/settings';
import TabBar from './components/TabBar';
import LibraryPage from './pages/LibraryPage';
import UpdatesPage from './pages/UpdatesPage';
import HistoryPage from './pages/HistoryPage';
import BrowsePage from './pages/BrowsePage';
import MorePage from './pages/MorePage';
import MangaDetailsPage from './pages/MangaDetailsPage';
import ReaderPage from './pages/ReaderPage';
import SettingsPage from './pages/SettingsPage';
import ExtensionsPage from './pages/ExtensionsPage';
import './index.css';

const tabPages = {
  library: LibraryPage,
  updates: UpdatesPage,
  history: HistoryPage,
  browse: BrowsePage,
  more: MorePage,
};

function Shell() {
  const { tab, route } = useNav();

  if (route.name === 'details') {
    return <MangaDetailsPage mangaKey={route.mangaKey} />;
  }

  if (route.name === 'reader') {
    return (
      <ReaderPage mangaKey={route.mangaKey} chapterId={route.chapterId} />
    );
  }

  if (route.name === 'settings') {
    return <SettingsPage />;
  }

  if (route.name === 'extensions') {
    return <ExtensionsPage />;
  }

  const ActiveTabPage = tabPages[tab];

  return (
    <>
      <ActiveTabPage />
      <TabBar />
    </>
  );
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings);

  useEffect(() => onSettingsChange(setSettings), []);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  return (
    <NavProvider>
      <div className="app">
        <Shell />
      </div>
    </NavProvider>
  );
}
