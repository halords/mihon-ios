export const SYNC_STORES = ['manga', 'chapterMeta', 'chapterState', 'library', 'history', 'categories', 'libraryPreferences'] as const;
export type SyncStore = typeof SYNC_STORES[number];
export interface SyncChange {
  id: string; store: SyncStore; key: string; clock: number; deviceId: string;
  deleted: boolean; data: Record<string, unknown> | null;
}
export interface SyncRecord extends SyncChange { pending: boolean }
export interface RemoteChange extends SyncChange { revision: number }
export interface AccountUser { id: string; email: string }

export const PROFILE_STORES = [...SYNC_STORES, 'downloads', 'downloadQueue', 'backendBindings', 'archives', 'metadata'] as const;
export interface DeviceProfile {
  key: string;
  stores: Partial<Record<typeof PROFILE_STORES[number], unknown[]>>;
  records: SyncRecord[]; cursor: number; clock: number; lastSync: number;
}

// On-disk snapshot layout (syncProfiles store). A whole device library
// does not fit in one IndexedDB value — Chrome caps a single value at
// ~127 MB and a restored library serializes past 150 MB — so snapshots
// are stored as a manifest plus chunk records of a few thousand rows
// each. DeviceProfile remains the logical, reassembled shape; records
// written by older builds (a bare DeviceProfile) are still read as-is.
export interface ProfileManifest {
  key: string; chunked: true; cursor: number; clock: number; lastSync: number;
  storeChunks: Partial<Record<typeof PROFILE_STORES[number], number>>;
  storeCounts: Partial<Record<typeof PROFILE_STORES[number], number>>;
  recordChunks: number; recordCount: number;
}
export interface ProfileChunk { key: string; chunk: true; rows: unknown[]; }
export type StoredProfile = DeviceProfile | ProfileManifest | ProfileChunk;

export function syncId(store: string, key: string): string { return store + '\u0000' + key; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item ?? null)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function projectSyncData(store: SyncStore, value: Record<string, unknown>): Record<string, unknown> {
  const data = { ...value };
  if (store === 'chapterState') { delete data.downloaded; data.bookmark = !!data.bookmark; data.pageOffset = data.pageOffset ?? 0; }
  return JSON.parse(canonical(data)) as Record<string, unknown>;
}
export function newer(a: SyncChange, b: SyncChange): boolean {
  return a.clock > b.clock || a.clock === b.clock && a.deviceId > b.deviceId;
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function validChange(value: unknown): value is SyncChange {
  if (!object(value) || !SYNC_STORES.includes(value.store as SyncStore) || typeof value.key !== 'string' || !value.key || value.key.length > 4096 ||
      value.id !== syncId(value.store as string, value.key) || !Number.isSafeInteger(value.clock) || (value.clock as number) < 0 ||
      typeof value.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.deviceId) || typeof value.deleted !== 'boolean') return false;
  if (value.deleted) return value.data === null;
  const data = value.data;
  if (!object(data) || canonical(data).length > 128 * 1024) return false;
  if (value.store === 'libraryPreferences') return value.key === 'arrangement' && data.key === value.key &&
    ['grid', 'list'].includes(String(data.libraryView)) && ['title', 'added', 'read', 'unread', 'updated', 'chapters', 'latest', 'fetched', 'random'].includes(String(data.librarySort)) &&
    ['ascending', 'descending'].includes(String(data.librarySortDirection)) && Number.isSafeInteger(data.libraryRandomSeed);
  if (value.store === 'categories') return data.id === value.key && typeof data.name === 'string' && !!data.name.trim() && Number.isFinite(data.order);
  if (data.key !== value.key) return false;
  if (value.store === 'manga') return object(data.manga) && typeof data.manga.id === 'string' && typeof data.manga.sourceId === 'string' &&
    value.key === data.manga.sourceId + '::' + data.manga.id && typeof data.manga.title === 'string' && typeof data.manga.coverUrl === 'string' && Array.isArray(data.manga.genres);
  if (value.store === 'library') return typeof data.category === 'string' && Number.isFinite(data.addedAt) &&
    (data.categories === undefined || Array.isArray(data.categories) && data.categories.every(item => typeof item === 'string'));
  if (typeof data.mangaKey !== 'string' || !value.key.startsWith(data.mangaKey + '::')) return false;
  if (value.store === 'chapterMeta') return object(data.chapter) && typeof data.chapter.id === 'string' && value.key === data.mangaKey + '::' + data.chapter.id && typeof data.chapter.name === 'string' && Number.isFinite(data.chapter.number);
  if (value.store === 'chapterState') return typeof data.read === 'boolean' && Number.isFinite(data.lastPage) && (data.lastPage as number) >= 0 && data.downloaded === undefined;
  return typeof data.mangaTitle === 'string' && typeof data.chapterName === 'string' && typeof data.coverUrl === 'string' && Number.isFinite(data.updatedAt) && Number.isFinite(data.page) && (data.page as number) >= 0;
}
