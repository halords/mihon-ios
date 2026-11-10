import { useSyncExternalStore } from 'react';
import { unwrap } from 'idb';
import { getRawDB, importData, dispatchDataEvent, type BackupData } from './db';
import { newer, PROFILE_STORES, validChange, type AccountUser, type DeviceProfile, type RemoteChange, type SyncRecord } from './syncTypes';
import { observeSyncClock, setSyncProfileContext } from './syncStorage';

export interface AccountState {
  configured: boolean | null; user: AccountUser | null;
  status: 'loading' | 'signed-out' | 'syncing' | 'ready' | 'offline' | 'error';
  lastSync: number; pending: number; error: string; deviceLibrary: number; recoveryCode: string;
}
let state: AccountState = { configured: null, user: null, status: 'loading', lastSync: 0, pending: 0, error: '', deviceLibrary: 0, recoveryCode: '' };
const listeners = new Set<() => void>();
const publish = (patch: Partial<AccountState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
export function getAccountState(): AccountState { return state; }
export function useAccount(): AccountState { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, getAccountState); }
let initialized: Promise<void> | undefined;
let running: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let sessionVerified = false;
let generation = 0;
let channel: BroadcastChannel | undefined;

class SessionError extends Error {}
async function request(action: string, input?: unknown, accountId?: string) {
  const headers: Record<string, string> = { 'X-Mihon-Request': '1' };
  if (input !== undefined) headers['Content-Type'] = 'application/json';
  if (accountId) headers['X-Mihon-Account'] = accountId;
  const response = await fetch('/api/account?action=' + action, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers, ...(input !== undefined ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) {
    if ((response.status === 401 || response.status === 409) && accountId) throw new SessionError(data.error ?? 'Sign in again to continue syncing.');
    throw new Error(data.error ?? 'Unable to connect to your account.');
  }
  return data;
}
function cacheUser(user: AccountUser | null): void {
  try { if (user) localStorage.setItem('mihon-account', JSON.stringify(user)); else localStorage.removeItem('mihon-account'); } catch { /* The database retains the offline profile. */ }
}

export async function activateAccountProfile(userId: string): Promise<void> {
  const db = await getRawDB();
  const tx = db.transaction([...PROFILE_STORES, 'syncRecords', 'syncControl', 'syncProfiles'] as const, 'readwrite');
  const owner = String((await tx.objectStore('syncControl').get('owner'))?.value ?? 'guest');
  if (owner === userId) { setSyncProfileContext(userId); await tx.done; return; }
  const stores: DeviceProfile['stores'] = {};
  await Promise.all(PROFILE_STORES.map(async store => { stores[store] = await tx.objectStore(store).getAll(); }));
  const profile: DeviceProfile = { key: owner, stores, records: await tx.objectStore('syncRecords').getAll(),
    cursor: Number((await tx.objectStore('syncControl').get('cursor'))?.value ?? 0), clock: Number((await tx.objectStore('syncControl').get('clock'))?.value ?? 0), lastSync: Number((await tx.objectStore('syncControl').get('lastSync'))?.value ?? 0) };
  await tx.objectStore('syncProfiles').put(profile);
  const next = await tx.objectStore('syncProfiles').get(userId);
  for (const store of PROFILE_STORES) {
    await tx.objectStore(store).clear();
    for (const record of next?.stores[store] ?? []) unwrap(tx.objectStore(store)).put(record);
  }
  await tx.objectStore('syncRecords').clear();
  for (const record of next?.records ?? []) unwrap(tx.objectStore('syncRecords')).put(record);
  for (const [key, value] of Object.entries({ owner: userId, cursor: next?.cursor ?? 0, clock: next?.clock ?? 0, lastSync: next?.lastSync ?? 0 })) await tx.objectStore('syncControl').put({ key, value });
  await tx.done;
  observeSyncClock(next?.clock ?? 0); setSyncProfileContext(userId);
  dispatchDataEvent(); dispatchDataEvent('mihon:downloads-changed');
  channel?.postMessage({ type: 'profile', userId });
}
export async function acknowledgeChanges(sent: SyncRecord[], userId: string): Promise<void> {
  const db = await getRawDB(); const tx = db.transaction(['syncRecords', 'syncControl'], 'readwrite');
  if ((await tx.objectStore('syncControl').get('owner'))?.value !== userId) {
    tx.abort(); await tx.done.catch(() => {}); throw new SessionError('The active account changed.');
  }
  for (const record of sent) {
    const current = await tx.objectStore('syncRecords').get(record.id);
    if (current?.clock === record.clock && current.deviceId === record.deviceId) await tx.objectStore('syncRecords').put({ ...current, pending: false });
  }
  await tx.done;
}
export async function applyRemoteChanges(changes: RemoteChange[], cursor: number, userId: string): Promise<void> {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || changes.some(change => !validChange(change) || !Number.isSafeInteger(change.revision))) throw new Error('The server returned invalid sync data.');
  const db = await getRawDB(); const tx = db.transaction([...PROFILE_STORES, 'syncRecords', 'syncControl'] as const, 'readwrite');
  const owner = String((await tx.objectStore('syncControl').get('owner'))?.value ?? 'guest');
  if (owner !== userId) { tx.abort(); await tx.done.catch(() => {}); throw new SessionError('The active account changed.'); }
  let clock = Number((await tx.objectStore('syncControl').get('clock'))?.value ?? 0);
  for (const change of changes) {
    clock = Math.max(clock, change.clock);
    const local = await tx.objectStore('syncRecords').get(change.id);
    if (local && newer(local, change)) continue;
    if (change.deleted) await tx.objectStore(change.store).delete(change.key);
    else {
      let value = change.data!;
      if (change.store === 'chapterState') {
        const previous = await tx.objectStore('chapterState').get(change.key);
        value = { ...value, downloaded: previous?.downloaded ?? false };
      }
      await tx.objectStore(change.store).put(value as never);
    }
    await tx.objectStore('syncRecords').put({ ...change, pending: false });
  }
  await tx.objectStore('syncControl').put({ key: 'clock', value: clock });
  await tx.objectStore('syncControl').put({ key: 'cursor', value: cursor });
  await tx.done; observeSyncClock(clock);
  if (changes.length) dispatchDataEvent();
}

async function summary(): Promise<void> {
  const db = await getRawDB();
  const [records, last, guest] = await Promise.all([db.getAll('syncRecords'), db.get('syncControl', 'lastSync'), db.get('syncProfiles', 'guest')]);
  publish({ pending: records.filter(record => record.pending).length, lastSync: Number(last?.value ?? 0), deviceLibrary: (guest?.stores.library?.length ?? 0) + (guest?.stores.history?.length ?? 0) });
}
function schedule(): void {
  if (timer || !state.user) return;
  timer = setTimeout(() => { timer = undefined; void syncAccount(); }, 1000);
}
export function syncAccount(): Promise<void> {
  if (running) return running;
  running = cycle().finally(() => { running = undefined; });
  return running;
}
async function cycle(): Promise<void> {
  if (!state.user || !sessionVerified) return;
  if (!navigator.onLine) { await summary(); publish({ status: 'offline' }); return; }
  const accountId = state.user.id; const currentGeneration = generation;
  publish({ status: 'syncing', error: '' });
  try {
    const db = await getRawDB();
    if ((await db.get('syncControl', 'owner'))?.value !== accountId) throw new SessionError('The active account changed.');
    const pending = (await db.getAll('syncRecords')).filter(record => record.pending);
    // Batches stay below serverless request limits even for large libraries.
    for (let start = 0; start < pending.length;) {
      if (generation !== currentGeneration) return;
      const batch: SyncRecord[] = []; let bytes = 0;
      while (start < pending.length && batch.length < 256) {
        const record = pending[start]!; const size = JSON.stringify(record).length * 3;
        if (batch.length && bytes + size > 1024 * 1024) break;
        if (!validChange(record)) throw new Error('A local record cannot be synced. Export your library and report this error.');
        batch.push(record); bytes += size; start++;
      }
      await request('push', { changes: batch }, accountId);
      if (generation !== currentGeneration) return;
      await acknowledgeChanges(batch, accountId);
    }
    let cursor = Number((await db.get('syncControl', 'cursor'))?.value ?? 0);
    for (;;) {
      if (generation !== currentGeneration) return;
      const result = await request('pull&cursor=' + cursor, undefined, accountId);
      if (generation !== currentGeneration) return;
      if (!Array.isArray(result.changes) || result.cursor < cursor || result.hasMore && result.cursor <= cursor) throw new Error('The server returned an invalid sync page.');
      await applyRemoteChanges(result.changes, result.cursor, accountId);
      cursor = result.cursor;
      if (!result.hasMore) break;
    }
    await db.put('syncControl', { key: 'lastSync', value: Date.now() });
    await summary(); publish({ status: 'ready' });
    if (state.pending) schedule();
  } catch (error) {
    if (generation !== currentGeneration) return;
    await summary();
    if (error instanceof SessionError) sessionVerified = false;
    publish({ status: navigator.onLine ? 'error' : 'offline', error: error instanceof Error ? error.message : 'Unable to sync. Changes are saved on this device.' });
  }
}
export async function addDeviceLibrary(): Promise<void> {
  if (!state.user || !sessionVerified) throw new Error('Sign in before adding your device library.');
  const db = await getRawDB(); const guest = await db.get('syncProfiles', 'guest');
  if (!guest) return;
  const data: BackupData = { version: 2, exportedAt: Date.now(), manga: [], chapterMeta: [], chapterState: [], library: [], history: [], downloads: [], categories: [] };
  for (const store of ['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'categories', 'downloads'] as const) (data[store] as unknown[]) = guest.stores[store] ?? [];
  await importData(data);
  // Original archives and local downloads remain useful after connecting an
  // account, but are never sent to the cloud sync endpoint.
  const tx = db.transaction(['archives', 'metadata', 'backendBindings', 'downloadQueue', 'syncProfiles'], 'readwrite');
  for (const store of ['archives', 'metadata', 'backendBindings', 'downloadQueue'] as const) {
    for (const value of guest.stores[store] ?? []) {
      const record = value as Record<string, unknown>;
      const key = String(record.id ?? record.key);
      if (!await tx.objectStore(store).get(key)) await tx.objectStore(store).put(value as never);
    }
  }
  await tx.objectStore('syncProfiles').delete('guest'); await tx.done;
  dispatchDataEvent('mihon:downloads-changed');
  const { setDownloadsPaused } = await import('./downloadQueue');
  await setDownloadsPaused(!!(await db.get('metadata', 'downloads:paused'))?.value);
  await summary(); await syncAccount();
}
async function connect(user: AccountUser): Promise<void> {
  generation++; sessionVerified = false;
  if (running) await running;
  // Stop a foreground download before switching its database profile.
  const db = await getRawDB();
  const switching = String((await db.get('syncControl', 'owner'))?.value ?? 'guest') !== user.id;
  const { setDownloadsPaused, waitForDownloadsIdle } = await import('./downloadQueue');
  if (switching) {
    const wasPaused = !!(await db.get('metadata', 'downloads:paused'))?.value;
    await setDownloadsPaused(true); await waitForDownloadsIdle();
    await db.put('metadata', { key: 'downloads:paused', value: wasPaused });
  }
  await activateAccountProfile(user.id);
  if (switching) await setDownloadsPaused(!!(await db.get('metadata', 'downloads:paused'))?.value);
  cacheUser(user); sessionVerified = true;
  publish({ user, configured: true, error: '', status: 'syncing' });
  await summary();
}
export async function signInAccount(email: string, password: string): Promise<void> {
  const result = await request('login', { email, password });
  await connect(result.user); publish({ recoveryCode: '' }); await syncAccount();
}
export async function createAccount(email: string, password: string): Promise<void> {
  const result = await request('register', { email, password });
  await connect(result.user); publish({ recoveryCode: result.recoveryCode });
  await addDeviceLibrary(); await syncAccount();
}
export async function recoverAccount(email: string, recoveryCode: string, password: string): Promise<void> {
  const result = await request('recover', { email, recoveryCode, password });
  await connect(result.user); publish({ recoveryCode: result.recoveryCode }); await syncAccount();
}
export async function signOutAccount(): Promise<void> {
  if (!navigator.onLine) throw new Error('Connect to the internet to sign out securely.');
  generation++;
  if (running) await running;
  const id = state.user?.id;
  await request('logout', {}, id);
  sessionVerified = false; cacheUser(null);
  publish({ user: null, status: 'signed-out', error: '', recoveryCode: '' });
  channel?.postMessage({ type: 'session' });
}
export function dismissRecoveryCode(): void { publish({ recoveryCode: '' }); }
async function refreshSession(): Promise<void> {
  if (!navigator.onLine) { publish({ status: state.user ? 'offline' : 'signed-out' }); return; }
  try {
    const result = await request('status');
    publish({ configured: !!result.configured });
    if (result.user) { await connect(result.user); await syncAccount(); }
    else { sessionVerified = false; cacheUser(null); publish({ user: null, status: 'signed-out', error: '' }); }
  } catch (error) { publish({ status: state.user ? 'offline' : 'error', error: error instanceof Error ? error.message : 'Unable to connect.' }); }
}
export function initAccount(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    const db = await getRawDB();
    setSyncProfileContext(String((await db.get('syncControl', 'owner'))?.value ?? 'guest'));
    observeSyncClock(Number((await db.get('syncControl', 'clock'))?.value ?? 0));
    try { const cached = JSON.parse(localStorage.getItem('mihon-account') ?? 'null'); if (cached?.id && cached?.email) publish({ user: cached }); } catch { /* First use. */ }
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('mihon-account');
      channel.onmessage = () => { if (typeof location.reload === 'function') location.reload(); };
    }
    window.addEventListener('mihon:sync-dirty', schedule);
    window.addEventListener('online', () => { void (sessionVerified ? syncAccount() : refreshSession()); });
    window.addEventListener('offline', () => { void summary().then(() => publish({ status: state.user ? 'offline' : 'signed-out' })); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void (sessionVerified ? syncAccount() : refreshSession()); });
    setInterval(() => { if (state.user && navigator.onLine) void (sessionVerified ? syncAccount() : refreshSession()); }, 10000);
    await refreshSession();
  })();
  return initialized;
}
