import { useEffect, useState, useSyncExternalStore } from 'react';
import { loadSettings, onSettingsChange } from './settings';
import { getQueueSnapshot, subscribeDownloads } from './downloadQueue';
import { getConnectionSnapshot, subscribeConnection } from './suwayomi';
import { onSourcesChange, sources } from '../sources';

export function useSettings() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => onSettingsChange(setSettings), []);
  return settings;
}
export function useQueue() { return useSyncExternalStore(subscribeDownloads, getQueueSnapshot); }
export function useConnection() { return useSyncExternalStore(subscribeConnection, getConnectionSnapshot); }
function onNetwork(fn: () => void) {
  window.addEventListener('online', fn); window.addEventListener('offline', fn);
  return () => { window.removeEventListener('online', fn); window.removeEventListener('offline', fn); };
}
export function useOnline(): boolean { return useSyncExternalStore(onNetwork, () => navigator.onLine !== false); }
export function useSources() {
  const [list, setList] = useState(() => [...sources]);
  useEffect(() => { setList([...sources]); return onSourcesChange(() => setList([...sources])); }, []);
  return list;
}
export function useDataEvents(reload: () => void, events = 'mihon:data-changed,mihon:library-changed,mihon:downloads-changed,mihon:sources-changed') {
  useEffect(() => {
    const names = events.split(',');
    for (const name of names) window.addEventListener(name, reload);
    return () => { for (const name of names) window.removeEventListener(name, reload); };
  }, [reload, events]);
}
