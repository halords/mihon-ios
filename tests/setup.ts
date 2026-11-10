import 'fake-indexeddb/auto';
import { beforeEach, vi } from 'vitest';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
export class MemoryCache {
  readonly entries = new Map<string, Response>();
  private key(input: RequestInfo | URL) { return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; }
  async match(input: RequestInfo | URL) { return this.entries.get(this.key(input))?.clone(); }
  async put(input: RequestInfo | URL, response: Response) { this.entries.set(this.key(input), response.clone()); }
  async delete(input: RequestInfo | URL) { return this.entries.delete(this.key(input)); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
}
export class MemoryCaches {
  private values = new Map<string, MemoryCache>();
  async open(key: string) { let cache = this.values.get(key); if (!cache) { cache = new MemoryCache(); this.values.set(key, cache); } return cache; }
  async delete(key: string) { return this.values.delete(key); }
  async keys() { return [...this.values.keys()]; }
}
export const testWindow = Object.assign(new EventTarget(), { localStorage: new MemoryStorage() });
export const testDocument = Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} }, querySelector: () => null });
vi.stubGlobal('window', testWindow);
vi.stubGlobal('document', testDocument);
vi.stubGlobal('localStorage', testWindow.localStorage);
vi.stubGlobal('sessionStorage', new MemoryStorage());
vi.stubGlobal('location', { origin: 'https://reader.example', protocol: 'https:', hash: '' });
vi.stubGlobal('navigator', { onLine: true, storage: { persist: async () => true } });
vi.stubGlobal('caches', new MemoryCaches());
vi.stubGlobal('BroadcastChannel', undefined);
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubGlobal('window', testWindow);
  vi.stubGlobal('document', testDocument);
  vi.stubGlobal('localStorage', testWindow.localStorage);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('location', { origin: 'https://reader.example', protocol: 'https:', hash: '' });
  vi.stubGlobal('BroadcastChannel', undefined);
  testWindow.localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('navigator', { onLine: true, storage: { persist: async () => true } });
  vi.stubGlobal('caches', new MemoryCaches());
  vi.stubGlobal('Worker', undefined);
  const { getRawDB } = await import('../src/lib/db');
  const db = await getRawDB();
  for (const name of db.objectStoreNames) await db.clear(name);
});
