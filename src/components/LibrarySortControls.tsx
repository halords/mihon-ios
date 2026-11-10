import { LIBRARY_SORT_OPTIONS } from '../lib/librarySort';
import { useSettings } from '../lib/hooks';
import { saveSettings, type LibrarySort } from '../lib/settings';

export default function LibrarySortControls() {
  const settings = useSettings();
  return <>
    <label className="form-row">Sort by<select aria-label="Sort library by" value={settings.librarySort} onChange={e => saveSettings({ librarySort: e.target.value as LibrarySort })}>
      {LIBRARY_SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>
    {settings.librarySort !== 'random' && <label className="form-row">Order<select aria-label="Library sort order" value={settings.librarySortDirection} onChange={e => saveSettings({ librarySortDirection: e.target.value as 'ascending' | 'descending' })}>
      <option value="descending">{settings.librarySort === 'title' ? 'Z to A' : ['read', 'added', 'updated', 'latest', 'fetched'].includes(settings.librarySort) ? 'Newest first' : 'Highest first'}</option>
      <option value="ascending">{settings.librarySort === 'title' ? 'A to Z' : ['read', 'added', 'updated', 'latest', 'fetched'].includes(settings.librarySort) ? 'Oldest first' : 'Lowest first'}</option>
    </select></label>}
    {settings.librarySort === 'random' && <button className="btn-ghost outlined wide" onClick={() => saveSettings({ libraryRandomSeed: Date.now() })}>Shuffle again</button>}
  </>;
}
