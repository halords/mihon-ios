import { expect, it, vi } from 'vitest';
import { getRawDB } from '../src/lib/db';
import { applyRemoteChanges, initAccount } from '../src/lib/account';
import { libraryArrangement, loadSettings, saveSettings } from '../src/lib/settings';
import { syncId } from '../src/lib/syncTypes';

it('keeps an imported device arrangement on startup and lets a just-selected sort win over an older in-flight pull', async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"configured":false,"user":null}', { headers: { 'Content-Type': 'application/json' } })));
  try {
    const db = await getRawDB();
    await db.put('libraryPreferences', { key: 'arrangement', librarySort: 'title', librarySortDirection: 'ascending', libraryView: 'grid', libraryRandomSeed: 1 });
    saveSettings({ librarySort: 'read', librarySortDirection: 'descending' });
    await initAccount();
    expect(loadSettings().librarySort).toBe('read');
    expect((await db.get('libraryPreferences', 'arrangement'))?.librarySort).toBe('read');
    saveSettings({ librarySort: 'title', librarySortDirection: 'ascending' });
    await applyRemoteChanges([{ id: syncId('libraryPreferences', 'arrangement'), store: 'libraryPreferences', key: 'arrangement', clock: 1, deviceId: 'old-device', revision: 1, deleted: false,
      data: { key: 'arrangement', ...libraryArrangement(), librarySort: 'read', librarySortDirection: 'descending' } }], 1, 'guest');
    expect(loadSettings().librarySort).toBe('title');
    expect((await db.get('libraryPreferences', 'arrangement'))?.librarySort).toBe('title');
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});
