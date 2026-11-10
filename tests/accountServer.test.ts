import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createClient, type Client } from '@libsql/client';
import { createAccountHandler } from '../server/account';
import { pushChanges, pullChanges } from '../server/accountDatabase';
import { syncId, type SyncChange } from '../src/lib/syncTypes';

let client: Client; let server: Server; let origin: string;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  server = createServer(createAccountHandler(client));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); client.close(); });
async function call(action: string, input?: unknown, cookie = '', id?: string, externalOrigin?: string) {
  const response = await fetch(origin + '/api/account?action=' + action, { method: input === undefined ? 'GET' : 'POST', headers: {
    'X-Mihon-Request': '1', 'Content-Type': 'application/json', Origin: externalOrigin ?? origin, Cookie: cookie, ...(id ? { 'X-Mihon-Account': id } : {}),
  }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '', cookieHeader: response.headers.get('set-cookie') ?? '' };
}
const register = (email = 'reader@example.com') => call('register', { email, password: 'correct horse battery staple' });
const library = (clock = 100, deleted = false): SyncChange => ({ id: syncId('library', 'mangadex::hero'), store: 'library', key: 'mangadex::hero', clock, deviceId: 'device-a', deleted, data: deleted ? null : { key: 'mangadex::hero', category: 'Reading', categories: ['Reading'], addedAt: 10 } });

it('creates hashed-password accounts, uses an HttpOnly session, and revokes it on sign-out', async () => {
  const created = await register(); expect(created.status).toBe(200); expect(created.cookieHeader).toContain('HttpOnly'); expect(created.cookieHeader).toContain('SameSite=Lax');
  const rows = (await client.execute('SELECT * FROM mihon_users')).rows;
  expect(rows[0]?.password_hash).not.toContain('correct horse'); expect(rows[0]?.recovery_hash).not.toBe(created.data.recoveryCode);
  expect((await call('status', undefined, created.cookie)).data.user.email).toBe('reader@example.com');
  expect((await call('login', { email: 'reader@example.com', password: 'wrong password' })).status).toBe(401);
  expect((await call('login', { email: 'READER@example.com', password: 'correct horse battery staple' })).status).toBe(200);
  expect((await call('logout', {}, created.cookie, created.data.user.id)).status).toBe(200);
  expect((await call('status', undefined, created.cookie)).data.user).toBeNull();
});
it('rejects cross-origin writes, invalid data, cross-account headers and unauthenticated sync', async () => {
  const created = await register();
  expect((await call('push', { changes: [library()] }, created.cookie, created.data.user.id, 'https://other.example')).status).toBe(403);
  expect((await call('push', { changes: [{ ...library(), store: 'users' }] }, created.cookie, created.data.user.id)).status).toBe(400);
  expect((await call('push', { changes: [library()] }, created.cookie, 'another-user')).status).toBe(409);
  expect((await call('pull&cursor=0')).status).toBe(401);
});
it('keeps users isolated and prevents stale devices from resurrecting removed titles', async () => {
  const a = await register('a@example.com'); const b = await register('b@example.com');
  await call('push', { changes: [library()] }, a.cookie, a.data.user.id);
  expect((await call('pull&cursor=0', undefined, b.cookie, b.data.user.id)).data.changes).toEqual([]);
  const first = (await call('pull&cursor=0', undefined, a.cookie, a.data.user.id)).data;
  expect(first.changes).toHaveLength(1);
  await call('push', { changes: [library(200, true), library(150)] }, a.cookie, a.data.user.id);
  const second = (await call('pull&cursor=' + first.cursor, undefined, a.cookie, a.data.user.id)).data;
  expect(second.changes).toHaveLength(1); expect(second.changes[0].deleted).toBe(true);
});
it('paginates a large library without skipping records and resolves equal clocks deterministically', async () => {
  const a = await register(); const id = a.data.user.id;
  const changes = Array.from({ length: 1005 }, (_, i) => ({ ...library(i), key: 'mangadex::hero-' + i, id: syncId('library', 'mangadex::hero-' + i), data: { key: 'mangadex::hero-' + i, category: 'Default', addedAt: 0 } }));
  await pushChanges(client, id, changes);
  const one = await pullChanges(client, id, 0); expect(one.changes).toHaveLength(1000); expect(one.hasMore).toBe(true);
  const two = await pullChanges(client, id, one.cursor); expect(two.changes).toHaveLength(5); expect(two.hasMore).toBe(false);
  await pushChanges(client, id, [{ ...library(5000), deviceId: 'device-z' }, { ...library(5000, true), deviceId: 'device-a' }]);
  expect((await pullChanges(client, id, two.cursor)).changes[0]?.deleted).toBe(false);
});
it('recovers an account with its one-time code, rotates the code, and revokes older sessions', async () => {
  const created = await register();
  const recovered = await call('recover', { email: 'reader@example.com', password: 'my replacement password', recoveryCode: created.data.recoveryCode });
  expect(recovered.status).toBe(200); expect(recovered.data.recoveryCode).not.toBe(created.data.recoveryCode);
  expect((await call('status', undefined, created.cookie)).data.user).toBeNull();
  expect((await call('recover', { email: 'reader@example.com', password: 'yet another password', recoveryCode: created.data.recoveryCode })).status).toBe(401);
  expect((await call('login', { email: 'reader@example.com', password: 'my replacement password' })).status).toBe(200);
});
it('bounds pull pages by bytes and keeps every large record available on the next page', async () => {
  const created = await register(); const id = created.data.user.id;
  const changes = Array.from({ length: 16 }, (_, i): SyncChange => {
    const key = 'mangadex::large-' + i;
    return { ...library(i), store: 'manga', key, id: syncId('manga', key), data: { key, manga: {
      id: 'large-' + i, sourceId: 'mangadex', title: 'Large record', coverUrl: '', genres: [], description: 'x'.repeat(100000),
    } } };
  });
  await pushChanges(client, id, changes);
  const one = await pullChanges(client, id, 0);
  expect(one.changes.length).toBeGreaterThan(0); expect(one.changes.length).toBeLessThan(changes.length);
  expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThan(1100000); expect(one.hasMore).toBe(true);
  const two = await pullChanges(client, id, one.cursor);
  expect(two.hasMore).toBe(false);
  expect(new Set([...one.changes, ...two.changes].map(change => change.id)).size).toBe(changes.length);
});
