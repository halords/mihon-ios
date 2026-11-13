import { useSyncExternalStore } from 'react';
import { unwrap } from 'idb';
import { getDB, getRawDB, importData, dispatchDataEvent, downloadRemovalKey, type BackupData } from './db';
import { emitLibraryLive } from './libraryLive';
import { newer, PROFILE_STORES, validChange, type AccountUser, type DeviceProfile, type ProfileChunk, type ProfileManifest, type RemoteChange, type StoredProfile, type SyncRecord } from './syncTypes';
import { observeSyncClock, setSyncProfileContext } from './syncStorage';
import { DEFAULT_SETTINGS, libraryArrangement, onLibraryArrangementChange, saveSettings, type LibraryArrangement } from './settings';

export interface AccountState {
  configured: boolean | null; user: AccountUser | null;
  status: 'loading' | 'signed-out' | 'syncing' | 'ready' | 'offline' | 'error';
  lastSync: number; pending: number; quarantined: number; error: string; deviceLibrary: number; recoveryCode: string;
}
let state: AccountState = { configured: null, user: null, status: 'loading', lastSync: 0, pending: 0, quarantined: 0, error: '', deviceLibrary: 0, recoveryCode: '' };
const listeners = new Set<() => void>();
const publish = (patch: Partial<AccountState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
export function getAccountState(): AccountState { return state; }
export function useAccount(): AccountState { return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, getAccountState); }
let initialized: Promise<void> | undefined;
let running: Promise<void> | undefined;
// Set by the 'mihon:sync-dirty' listener whenever local code journals a
// change; cleared when a cycle finishes a push+pull with nothing pending.
// Sync model (user direction, 2026-11-11): states save locally as they
// happen and sync in ONE batch when the app opens — plus a best-effort
// flush when the app is backgrounded or connectivity returns. There is
// no mid-session engine: no timer, no dirty-triggered cycle, so reading
// costs zero scans and zero network until the next open.
let syncDirty = false;
let sessionVerified = false;
let generation = 0;
let channel: BroadcastChannel | undefined;
let preferencesWrite = Promise.resolve();
async function restoreLibraryArrangement(preserveDevice = false): Promise<void> {
  const db = await getRawDB();
  const preferences = await db.get('libraryPreferences', 'arrangement');
  if (preserveDevice && !await db.get('syncRecords', 'libraryPreferences\u0000arrangement')) {
    // A pre-sync import may have restored its sort after the database upgrade
    // seeded default preferences. Preserve that device choice at startup.
    await db.put('libraryPreferences', { key: 'arrangement', ...libraryArrangement() });
    return;
  }
  saveSettings(preferences ? libraryArrangement(preferences) : libraryArrangement(DEFAULT_SETTINGS), { syncLibrary: false });
}
function saveLibraryArrangement(arrangement: LibraryArrangement): void {
  preferencesWrite = preferencesWrite.catch(() => {}).then(async () => {
    await (await getDB()).put('libraryPreferences', { key: 'arrangement', ...arrangement });
  });
  void preferencesWrite.catch(error => publish({ error: error instanceof Error ? error.message : 'Unable to save library arrangement for sync.' }));
}

class SessionError extends Error {}
async function request(action: string, input?: unknown, accountId?: string, timeoutMs = 30000) {
  const headers: Record<string, string> = { 'X-Mihon-Request': '1', 'X-Mihon-Sync-Version': '2' };
  if (input !== undefined) headers['Content-Type'] = 'application/json';
  if (accountId) headers['X-Mihon-Account'] = accountId;
  const response = await fetch('/api/account?action=' + action, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers, ...(input !== undefined ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(timeoutMs) });
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

// Profile snapshots are chunked (see StoredProfile in syncTypes.ts): a
// restored library serializes past Chrome's ~127 MB single-value limit,
// which made sign-in/registration fail outright on large guest libraries.
// Chunks hold a few thousand rows each; legacy single-record snapshots
// from older builds are still read unchanged.
const PROFILE_CHUNK_ROWS = 4000;
interface ProfileStoreHandle {
  get(key: string): Promise<StoredProfile | undefined>;
  getAll(query: IDBKeyRange): Promise<StoredProfile[]>;
  put(value: StoredProfile): Promise<unknown>;
  delete(query: string | IDBKeyRange): Promise<void>;
}
const chunkPrefix = (owner: string) => owner + '\u0000chunk\u0000';
async function deleteProfileSnapshot(store: ProfileStoreHandle, key: string): Promise<void> {
  const prefix = chunkPrefix(key);
  await store.delete(IDBKeyRange.bound(prefix, prefix + '\uFFFF'));
  await store.delete(key);
}
async function writeProfileSnapshot(store: ProfileStoreHandle, profile: DeviceProfile): Promise<void> {
  await deleteProfileSnapshot(store, profile.key);
  const prefix = chunkPrefix(profile.key);
  const storeChunks: ProfileManifest['storeChunks'] = {};
  const storeCounts: ProfileManifest['storeCounts'] = {};
  for (const name of PROFILE_STORES) {
    const rows = profile.stores[name] ?? [];
    storeCounts[name] = rows.length;
    const chunks = Math.ceil(rows.length / PROFILE_CHUNK_ROWS);
    storeChunks[name] = chunks;
    for (let i = 0; i < chunks; i++) {
      const chunk: ProfileChunk = { key: `${prefix}${name}\u0000${String(i).padStart(6, '0')}`, chunk: true, rows: rows.slice(i * PROFILE_CHUNK_ROWS, (i + 1) * PROFILE_CHUNK_ROWS) };
      await store.put(chunk);
    }
  }
  const recordChunks = Math.ceil(profile.records.length / PROFILE_CHUNK_ROWS);
  for (let i = 0; i < recordChunks; i++) {
    const chunk: ProfileChunk = { key: `${prefix}records\u0000${String(i).padStart(6, '0')}`, chunk: true, rows: profile.records.slice(i * PROFILE_CHUNK_ROWS, (i + 1) * PROFILE_CHUNK_ROWS) };
    await store.put(chunk);
  }
  const manifest: ProfileManifest = { key: profile.key, chunked: true, cursor: profile.cursor, clock: profile.clock, lastSync: profile.lastSync, storeChunks, storeCounts, recordChunks, recordCount: profile.records.length };
  await store.put(manifest);
}
async function readProfileSnapshot(store: ProfileStoreHandle, key: string): Promise<DeviceProfile | undefined> {
  const head = await store.get(key);
  if (!head) return undefined;
  if (!('chunked' in head)) return head as DeviceProfile;
  const manifest = head as ProfileManifest;
  const prefix = chunkPrefix(key);
  const chunks = (await store.getAll(IDBKeyRange.bound(prefix, prefix + '\uFFFF'))).filter((row): row is ProfileChunk => 'chunk' in row);
  const stores: DeviceProfile['stores'] = {};
  const records: unknown[] = [];
  for (const chunk of chunks) {
    const kind = chunk.key.slice(prefix.length).split('\u0000')[0]!;
    if (kind === 'records') records.push(...chunk.rows);
    else (stores[kind as keyof DeviceProfile['stores']] ??= []).push(...chunk.rows);
  }
  return { key, stores: stores as DeviceProfile['stores'], records: records as SyncRecord[], cursor: manifest.cursor, clock: manifest.clock, lastSync: manifest.lastSync };
}
async function guestProfileCount(db: Awaited<ReturnType<typeof getRawDB>>): Promise<number> {
  const store = db.transaction('syncProfiles').objectStore('syncProfiles') as unknown as ProfileStoreHandle;
  const head = await store.get('guest');
  if (!head) return 0;
  if ('chunked' in head) { const manifest = head as ProfileManifest; return (manifest.storeCounts.library ?? 0) + (manifest.storeCounts.history ?? 0); }
  const legacy = head as DeviceProfile;
  return (legacy.stores.library?.length ?? 0) + (legacy.stores.history?.length ?? 0);
}

export async function activateAccountProfile(userId: string): Promise<void> {
  const db = await getRawDB();
  const tx = db.transaction([...PROFILE_STORES, 'syncRecords', 'syncControl', 'syncProfiles'] as const, 'readwrite');
  const owner = String((await tx.objectStore('syncControl').get('owner'))?.value ?? 'guest');
  if (owner === userId) { setSyncProfileContext(userId); await tx.done; return; }
  const stores: DeviceProfile['stores'] = {};
  await Promise.all(PROFILE_STORES.map(async store => { stores[store] = await tx.objectStore(store).getAll(); }));
  stores.libraryPreferences = [{ key: 'arrangement', ...libraryArrangement() }];
  const profile: DeviceProfile = { key: owner, stores, records: await tx.objectStore('syncRecords').getAll(),
    cursor: Number((await tx.objectStore('syncControl').get('cursor'))?.value ?? 0), clock: Number((await tx.objectStore('syncControl').get('clock'))?.value ?? 0), lastSync: Number((await tx.objectStore('syncControl').get('lastSync'))?.value ?? 0) };
  await writeProfileSnapshot(tx.objectStore('syncProfiles') as unknown as ProfileStoreHandle, profile);
  const next = await readProfileSnapshot(tx.objectStore('syncProfiles') as unknown as ProfileStoreHandle, userId);
  for (const store of PROFILE_STORES) {
    await tx.objectStore(store).clear();
    for (const record of next?.stores[store] ?? []) unwrap(tx.objectStore(store)).put(record);
  }
  await tx.objectStore('syncRecords').clear();
  for (const record of next?.records ?? []) unwrap(tx.objectStore('syncRecords')).put(record);
  for (const [key, value] of Object.entries({ owner: userId, cursor: next?.cursor ?? 0, clock: next?.clock ?? 0, lastSync: next?.lastSync ?? 0 })) await tx.objectStore('syncControl').put({ key, value });
  await tx.done;
  observeSyncClock(next?.clock ?? 0); setSyncProfileContext(userId);
  await restoreLibraryArrangement();
  dispatchDataEvent(); dispatchDataEvent('mihon:downloads-changed');
  // Replace the previous profile's library snapshot after the switch lands.
  emitLibraryLive({ type: 'library-invalidated' });
  channel?.postMessage({ type: 'profile', userId });
}
export async function acknowledgeChanges(sent: SyncRecord[], userId: string): Promise<void> {
  const db = await getRawDB(); const tx = db.transaction(['syncRecords', 'syncControl'], 'readwrite');
  if ((await tx.objectStore('syncControl').get('owner'))?.value !== userId) {
    tx.abort(); await tx.done.catch(() => {}); throw new SessionError('The active account changed.');
  }
  // Scoped read: queue one native get per record in the batch (the same
  // pattern applyRemoteChanges uses), then queued native puts completed
  // by tx.done. Was: a getAll() over the whole store — at 130k+ records
  // (chapter payloads included) that full scan ran after EVERY batch and
  // dwarfed the upload itself. The guard is unchanged: a record is marked
  // synced only if its clock and device still match what was sent, so a
  // record edited mid-flight stays pending.
  const store = unwrap(tx.objectStore('syncRecords'));
  const rows = sent.length ? await nativeGetAll(store, sent.map(record => record.id)) : [];
  const current = new Map(sent.map((record, i) => [record.id, rows[i] as SyncRecord | undefined]));
  for (const record of sent) {
    const existing = current.get(record.id);
    if (existing?.clock === record.clock && existing.deviceId === record.deviceId) store.put({ ...existing, pending: 0 });
  }
  await tx.done;
}
// Queue every get on the native store up front; the transaction works
// through them in order and Promise.all settles with the last one. One
// pass through the request queue instead of an awaited round trip per
// record (SYNC-REVISION-SPEC.md).
function nativeGetAll(store: IDBObjectStore, keys: IDBValidKey[]): Promise<unknown[]> {
  return Promise.all(keys.map(key => new Promise<unknown>((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  })));
}

export async function applyRemoteChanges(changes: RemoteChange[], cursor: number, userId: string): Promise<void> {
  // Persist a just-selected sort before comparing it with an in-flight pull.
  await preferencesWrite;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || changes.some(change => !validChange(change) || !Number.isSafeInteger(change.revision))) throw new Error('The server returned invalid sync data.');
  const db = await getRawDB(); const tx = db.transaction([...PROFILE_STORES, 'syncRecords', 'syncControl'] as const, 'readwrite');
  const owner = String((await tx.objectStore('syncControl').get('owner'))?.value ?? 'guest');
  if (owner !== userId) { tx.abort(); await tx.done.catch(() => {}); throw new SessionError('The active account changed.'); }
  let clock = Number((await tx.objectStore('syncControl').get('clock'))?.value ?? 0);
  const removals = new Set<string>();
  // Bulk merge: read everything the decisions need in queued passes, then
  // queue every write natively and let tx.done be the completion barrier.
  // Record ids are unique within a page, so the maps cannot go stale
  // mid-loop, and native requests execute in issue order — the result is
  // identical to the old per-change awaited path, in a fraction of the
  // round trips.
  const nativeStores = new Map<string, IDBObjectStore>();
  const nativeStore = (name: string): IDBObjectStore => {
    const existing = nativeStores.get(name);
    if (existing) return existing;
    const raw: object = tx.objectStore(name as never);
    const store = unwrap(raw as never) as unknown as IDBObjectStore;
    nativeStores.set(name, store);
    return store;
  };
  const localRows = await nativeGetAll(nativeStore('syncRecords'), changes.map(change => change.id));
  const locals = new Map(changes.map((change, i) => [change.id, localRows[i] as SyncRecord | undefined]));
  const stateKeys = changes.filter(change => change.store === 'chapterState' && !change.deleted).map(change => change.key);
  const stateRows = await nativeGetAll(nativeStore('chapterState'), stateKeys);
  const previousStates = new Map(stateKeys.map((key, i) => [key, stateRows[i] as { downloaded?: boolean } | undefined]));
  for (const change of changes) {
    clock = Math.max(clock, change.clock);
    const local = locals.get(change.id);
    if (local && newer(local, change)) continue;
    if (change.store === 'library') {
      if (change.deleted) {
        nativeStore('metadata').put({ key: downloadRemovalKey(change.key), value: { pending: true } });
        removals.add(change.key);
      } else {
        nativeStore('metadata').delete(downloadRemovalKey(change.key));
        removals.delete(change.key);
      }
    }
    if (change.deleted) nativeStore(change.store).delete(change.key);
    else {
      let value = change.data!;
      if (change.store === 'chapterState') {
        value = { ...value, downloaded: previousStates.get(change.key)?.downloaded ?? false };
      }
      nativeStore(change.store).put(value);
    }
    nativeStore('syncRecords').put({ ...change, pending: 0 });
  }
  nativeStore('syncControl').put({ key: 'clock', value: clock });
  nativeStore('syncControl').put({ key: 'cursor', value: cursor });
  await tx.done; observeSyncClock(clock);
  for (const key of removals) await (await import('./libraryFiles')).purgeMangaFiles(key);
  if (changes.some(change => change.store === 'libraryPreferences')) await restoreLibraryArrangement();
  if (changes.length) dispatchDataEvent();
}

// Stream the syncRecords store instead of materializing it with
// getAll(): on a large library the store holds 100k+ records with full
// change payloads, and the callers below need only the pending subset
// (or a count of it). Cursor order is primary-key order — identical to
// getAll() — so collected records keep their previous sequence.
// Pending lookup via the 'by-pending' index (db v8). The old implementation
// cursor-scanned the WHOLE syncRecords store — 100k+ records with full
// payloads — on every cycle and every summary, several times a minute while
// reading (progress saves keep dirtying the journal). Index range scans touch
// only the handful of records actually awaiting upload.
async function scanSyncRecords(db: Awaited<ReturnType<typeof getRawDB>>, visit: (record: SyncRecord) => void): Promise<void> {
  let cursor = await db.transaction('syncRecords').objectStore('syncRecords').index('by-pending').openCursor(IDBKeyRange.only(1));
  while (cursor) { visit(cursor.value); cursor = await cursor.continue(); }
}

async function summary(): Promise<void> {
  const db = await getRawDB();
  let pending = 0;
  const [, last, guestCount, quarantined] = await Promise.all([
    scanSyncRecords(db, record => { if (record.pending) pending++; }),
    db.get('syncControl', 'lastSync'), guestProfileCount(db),
    db.get('metadata', 'sync:quarantined'),
  ]);
  publish({
    pending, lastSync: Number(last?.value ?? 0), deviceLibrary: guestCount,
    quarantined: Array.isArray(quarantined?.value) ? quarantined.value.length : 0,
  });
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
    const pending: SyncRecord[] = [];
    await scanSyncRecords(db, record => { if (record.pending) pending.push(record); });
    // Batches are sized by exact serialized bytes (SYNC-REVISION-SPEC.md):
    // up to 4,000 records or 3.5 MB per request, whichever comes first —
    // under the server's 4 MB cap, which is under Vercel's 4.5 MB limit.
    // Still strictly sequential: send, acknowledge, publish the new
    // pending count, then the next batch.
    const encoder = new TextEncoder();
    const quarantined: SyncRecord[] = [];
    for (let start = 0; start < pending.length;) {
      if (generation !== currentGeneration) return;
      const batch: SyncRecord[] = []; let bytes = 16; // {"changes":[]} envelope
      while (start < pending.length && batch.length < 4000) {
        const record = pending[start]!;
        if (!validChange(record)) {
          quarantined.push(record); start++;
          continue;
        }
        const size = encoder.encode(JSON.stringify(record)).length + 1;
        if (batch.length && bytes + size > 3.5 * 1024 * 1024) break;
        batch.push(record); bytes += size; start++;
      }
      if (!batch.length) continue;
      await request('push', { changes: batch }, accountId, 120000);
      if (generation !== currentGeneration) return;
      await acknowledgeChanges(batch, accountId);
      await summary();
    }
    if (quarantined.length) {
      // One oversized/corrupt local record must not wedge all of sync:
      // pending 0 stops the by-pending scan retrying it every open, its
      // id is stashed in metadata for the Account page count, and a later
      // edit re-journals the record as pending so it is validated fresh.
      const tx = db.transaction(['syncRecords', 'metadata'], 'readwrite');
      for (const record of quarantined) await tx.objectStore('syncRecords').put({ ...record, pending: 0 });
      const saved = await tx.objectStore('metadata').get('sync:quarantined');
      const ids = new Set<string>(Array.isArray(saved?.value) ? saved.value : []);
      for (const record of quarantined) ids.add(record.id);
      await tx.objectStore('metadata').put({ key: 'sync:quarantined', value: [...ids] });
      await tx.done;
    }
    let cursor = Number((await db.get('syncControl', 'cursor'))?.value ?? 0);
    for (;;) {
      if (generation !== currentGeneration) return;
      const result = await request('pull&cursor=' + cursor, undefined, accountId, 120000);
      if (generation !== currentGeneration) return;
      if (!Array.isArray(result.changes) || result.cursor < cursor || result.hasMore && result.cursor <= cursor) throw new Error('The server returned an invalid sync page.');
      await applyRemoteChanges(result.changes, result.cursor, accountId);
      cursor = result.cursor;
      if (!result.hasMore) break;
    }
    if (!await db.get('syncRecords', 'libraryPreferences\u0000arrangement')) {
      const preferences = await db.get('libraryPreferences', 'arrangement');
      await (await getDB()).put('libraryPreferences', preferences ?? { key: 'arrangement', ...libraryArrangement() });
    }
    await db.put('syncControl', { key: 'lastSync', value: Date.now() });
    await summary(); publish({ status: 'ready' });
    if (!state.pending) syncDirty = false;
  } catch (error) {
    if (generation !== currentGeneration) return;
    await summary();
    if (error instanceof SessionError) sessionVerified = false;
    publish({ status: navigator.onLine ? 'error' : 'offline', error: error instanceof Error ? error.message : 'Unable to sync. Changes are saved on this device.' });
  }
}
export async function addDeviceLibrary(): Promise<void> {
  if (!state.user || !sessionVerified) throw new Error('Sign in before adding your device library.');
  const db = await getRawDB(); const guest = await readProfileSnapshot(db.transaction('syncProfiles').objectStore('syncProfiles') as unknown as ProfileStoreHandle, 'guest');
  if (!guest) return;
  const data: BackupData = { version: 2, exportedAt: Date.now(), manga: [], chapterMeta: [], chapterState: [], library: [], history: [], downloads: [], categories: [] };
  for (const store of ['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'categories', 'downloads'] as const) (data[store] as unknown[]) = guest.stores[store] ?? [];
  await importData(data);
  const arrangement = guest.stores.libraryPreferences?.[0] as (LibraryArrangement & { key: string }) | undefined;
  if (arrangement) {
    await (await getDB()).put('libraryPreferences', { key: 'arrangement', ...libraryArrangement(arrangement) });
    await restoreLibraryArrangement();
  }
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
  await deleteProfileSnapshot(tx.objectStore('syncProfiles') as unknown as ProfileStoreHandle, 'guest'); await tx.done;
  dispatchDataEvent('mihon:downloads-changed');
  const { setDownloadsPaused } = await import('./downloadQueue');
  await setDownloadsPaused(!!(await db.get('metadata', 'downloads:paused'))?.value);
  // The profile-switch reload may precede this merge; reload again after adoption.
  emitLibraryLive({ type: 'library-invalidated' });
  await summary(); await syncAccount();
}
async function connect(user: AccountUser): Promise<void> {
  generation++; sessionVerified = false;
  if (running) await running;
  await preferencesWrite.catch(() => {});
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
  await connect(result.user); publish({ recoveryCode: '' });
  // Pull the account's cloud state BEFORE merging the device library, so
  // the import merges against current data instead of an empty profile.
  if (result.hasSyncedData) await syncAccount();
  // Always adopt the pre-sign-in device library (bug fix, 2026-11-11):
  // connect() swaps the live stores to the account profile, and adoption
  // used to run only for accounts with no synced data — so importing a
  // backup as a guest and THEN signing in to an established account left
  // the imported library stranded in its snapshot, visible again only
  // behind the manual "Add device library" button, which read as the
  // import being wiped. addDeviceLibrary no-ops when no snapshot exists.
  await addDeviceLibrary();
  await syncAccount();
}
export async function createAccount(email: string, password: string): Promise<void> {
  const result = await request('register', { email, password });
  await connect(result.user); publish({ recoveryCode: result.recoveryCode });
  await addDeviceLibrary(); await syncAccount();
}
export async function recoverAccount(email: string, recoveryCode: string, password: string): Promise<void> {
  const result = await request('recover', { email, recoveryCode, password });
  await connect(result.user); publish({ recoveryCode: result.recoveryCode });
  // Same adoption rule as sign-in: pull first, then merge any device
  // library that was in use before recovering the account.
  await syncAccount();
  await addDeviceLibrary();
  await syncAccount();
}
export async function signOutAccount(): Promise<void> {
  if (!navigator.onLine) throw new Error('Connect to the internet to sign out securely.');
  generation++;
  if (running) await running;
  await preferencesWrite.catch(() => {});
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
    await restoreLibraryArrangement(true);
    onLibraryArrangementChange(saveLibraryArrangement);
    try { const cached = JSON.parse(localStorage.getItem('mihon-account') ?? 'null'); if (cached?.id && cached?.email) publish({ user: cached }); } catch { /* First use. */ }
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('mihon-account');
      channel.onmessage = () => { if (typeof location.reload === 'function') location.reload(); };
    }
    window.addEventListener('mihon:sync-dirty', () => { syncDirty = true; });
    window.addEventListener('online', () => { void (sessionVerified ? syncAccount() : refreshSession()); });
    window.addEventListener('offline', () => { void summary().then(() => publish({ status: state.user ? 'offline' : 'signed-out' })); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void (sessionVerified ? syncAccount() : refreshSession());
      else if (sessionVerified && syncDirty) void syncAccount();
    });
    await refreshSession();
  })();
  return initialized;
}
