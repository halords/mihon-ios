import { unwrap, type IDBPDatabase, type StoreNames } from 'idb';
import type { MihonDB } from './db';
import { canonical, projectSyncData, SYNC_STORES, syncId, type SyncStore } from './syncTypes';

// A local write and its sync entry commit together, including writes made by
// imports and migrations. Remote/profile writes use getRawDB() to avoid echoes.
let clock = 0;
const NATIVE_SYNC = Symbol('native-sync');
export function observeSyncClock(value: number): void { clock = Math.max(clock, value); }
export function syncNativeStore(store: object): { put(value: unknown): unknown } { return Reflect.get(store, NATIVE_SYNC) ?? unwrap(store as never); }
const wrappers = new WeakMap<object, IDBPDatabase<MihonDB>>();
let expectedProfile = 'guest';
export function setSyncProfileContext(profile: string): void { expectedProfile = profile; }
let fallbackDeviceId: string | undefined;
function deviceId(): string {
  try {
    let id = localStorage.getItem('mihon-sync-device');
    if (!id) { id = fallbackDeviceId ??= crypto.randomUUID(); localStorage.setItem('mihon-sync-device', id); }
    return id;
  } catch { return fallbackDeviceId ??= crypto.randomUUID(); }
}
export async function trackSyncWrites(db: IDBPDatabase<MihonDB>): Promise<IDBPDatabase<MihonDB>> {
  const cached = wrappers.get(db);
  if (cached) return cached;
  expectedProfile = String((await db.get('syncControl', 'owner'))?.value ?? 'guest');
  const transaction = (scope: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) => {
    const names = typeof scope === 'string' ? [scope] : [...scope];
    const tracked = mode === 'readwrite' && names.some(name => SYNC_STORES.includes(name as SyncStore));
    if (!tracked) return db.transaction(names as StoreNames<MihonDB>[], mode, options);
    const tx = db.transaction([...new Set([...names, 'syncRecords', 'syncControl'])] as StoreNames<MihonDB>[], mode, options);
    const profile = expectedProfile;
    let nativeReady = false;
    const pendingNative: Array<{ name: SyncStore; key: string; data: Record<string, unknown> }> = [];
    const journalNative = ({ name, key, data }: typeof pendingNative[number]) => {
      clock = Math.max(Date.now(), clock + 1);
      unwrap(tx.objectStore('syncControl')).put({ key: 'clock', value: clock });
      unwrap(tx.objectStore('syncRecords')).put({ id: syncId(name, key), store: name, key, clock, deviceId: deviceId(), deleted: false, data, pending: 1 });
      dirty = true;
    };
    const ready = Promise.all([tx.objectStore('syncControl').get('owner'), tx.objectStore('syncControl').get('clock')]).then(([owner, previous]) => {
      if (String(owner?.value ?? 'guest') !== profile) throw new Error('The account changed in another tab. Reload before making changes.');
      observeSyncClock(Number(previous?.value ?? 0));
      nativeReady = true;
      for (const record of pendingNative) journalNative(record);
      pendingNative.length = 0;
    });
    void ready.catch(() => { try { tx.abort(); } catch { /* Already aborted. */ } });
    const stores = new Map<string, unknown>();
    let dirty = false;
    void tx.done.then(() => { if (dirty) window.dispatchEvent(new Event('mihon:sync-dirty')); }).catch(() => {});
    const store = (name: string) => {
      if (!SYNC_STORES.includes(name as SyncStore)) return tx.objectStore(name as never);
      if (stores.has(name)) return stores.get(name);
      const raw = tx.objectStore(name as SyncStore);
      const journal = async (key: string, data: Record<string, unknown> | null) => {
        const control = tx.objectStore('syncControl');
        const previous = await control.get('clock');
        clock = Math.max(Date.now(), clock + 1, Number(previous?.value ?? 0) + 1);
        const stamp = clock;
        await control.put({ key: 'clock', value: stamp });
        await tx.objectStore('syncRecords').put({ id: syncId(name, key), store: name as SyncStore, key, clock: stamp, deviceId: deviceId(), deleted: data === null, data, pending: 1 });
        dirty = true;
      };
      const wrapped = new Proxy(raw, { get(target, property) {
        if (property === NATIVE_SYNC) return { put(value: Record<string, unknown>) {
          const key = String(value.key ?? value.id);
          const result = unwrap(raw).put(value);
          const record = { name: name as SyncStore, key, data: projectSyncData(name as SyncStore, value) };
          if (nativeReady) journalNative(record); else pendingNative.push(record);
          return result;
        } };
        if (property === 'put' || property === 'add') return async (value: Record<string, unknown>, keyArg?: IDBValidKey) => {
          await ready;
          const key = String(keyArg ?? value.key ?? value.id);
          const previous = await target.get(key);
          const data = projectSyncData(name as SyncStore, value);
          const result = await target[property](value as never, keyArg as never);
          if (!previous || canonical(projectSyncData(name as SyncStore, previous as unknown as Record<string, unknown>)) !== canonical(data) || !await tx.objectStore('syncRecords').get(syncId(name, key))) await journal(key, data);
          return result;
        };
        if (property === 'delete') return async (key: IDBValidKey) => { await ready; await target.delete(key as never); await journal(String(key), null); };
        if (property === 'clear') return async () => {
          await ready;
          const keys = await target.getAllKeys();
          await target.clear();
          for (const key of keys) await journal(String(key), null);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      stores.set(name, wrapped); return wrapped;
    };
    return new Proxy(tx, { get(target, property) {
      if (property === 'store') return names.length === 1 ? store(names[0]!) : undefined;
      if (property === 'objectStore') return store;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const wrapped = new Proxy(db, { get(target, property) {
    if (property === 'transaction') return transaction;
    if (['put', 'add', 'delete', 'clear'].includes(String(property))) return async (name: string, ...args: unknown[]) => {
      const tx = transaction(name, 'readwrite');
      const store = tx.objectStore(name as never);
      const method = Reflect.get(store, property) as (...values: unknown[]) => Promise<unknown>;
      const result = await method.apply(store, args);
      await tx.done; return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  wrappers.set(db, wrapped); return wrapped;
}
