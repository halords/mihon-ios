import { Component, useEffect, useState, type ReactNode } from 'react';
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
import BackupPage from './pages/BackupPage';
import DownloadsPage from './pages/DownloadsPage';
import CategoriesPage from './pages/CategoriesPage';
import ConnectionsPage from './pages/ConnectionsPage';
import MigrationPage from './pages/MigrationPage';
import AccountPage from './pages/AccountPage';
import { PwaStatus, QueueBar } from './components/PwaStatus';
import { Toast } from './components/Feedback';
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
  if (route.name === 'downloads') return <DownloadsPage />;
  if (route.name === 'backup') return <BackupPage />;
  if (route.name === 'categories') return <CategoriesPage />;
  if (route.name === 'connections') return <ConnectionsPage />;
  if (route.name === 'migrate') return <MigrationPage mangaKey={route.mangaKey} />;
  if (route.name === 'account') return <AccountPage />;

  const ActiveTabPage = tabPages[tab];

  return (
    <>
      <ActiveTabPage />
      <QueueBar />
      <TabBar />
    </>
  );
}

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="reader-fallback"><h2>Unable to open this screen</h2><p>Your saved library has not been cleared.</p><button className="btn" onClick={() => { location.hash = '#/library'; location.reload(); }}>Return to library</button></div> : this.props.children;
  }
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
        <AppBoundary><PwaStatus /><Shell /></AppBoundary>
        <Toast />
      </div>
    </NavProvider>
  );
}
