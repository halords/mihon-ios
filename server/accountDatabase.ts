import { createClient, type Client, type InStatement } from '@libsql/client';
import { type SyncChange, type RemoteChange } from '../src/lib/syncTypes.ts';

export const ACCOUNT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mihon_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mihon_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES mihon_users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mihon_sessions_user ON mihon_sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS mihon_sync_clock (user_id TEXT PRIMARY KEY REFERENCES mihon_users(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS mihon_sync_records (user_id TEXT NOT NULL REFERENCES mihon_users(id) ON DELETE CASCADE, store TEXT NOT NULL, record_key TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL, client_clock INTEGER NOT NULL, device_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(user_id, store, record_key))`,
  `CREATE INDEX IF NOT EXISTS mihon_sync_revision ON mihon_sync_records(user_id, revision)`,
  `CREATE TABLE IF NOT EXISTS mihon_auth_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
];

export function accountClient(): Client | null {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) return null;
  if (!url.startsWith('file:') && !process.env.TURSO_AUTH_TOKEN) return null;
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}
export async function initializeAccounts(client: Client): Promise<void> { await client.batch(ACCOUNT_SCHEMA, 'write'); }

export async function pushChanges(client: Client, userId: string, changes: SyncChange[]): Promise<void> {
  const statements: InStatement[] = [{ sql: 'INSERT OR IGNORE INTO mihon_sync_clock(user_id,revision) VALUES (?,0)', args: [userId] }];
  for (const change of changes) {
    statements.push({ sql: 'UPDATE mihon_sync_clock SET revision=revision+1 WHERE user_id=?', args: [userId] });
    statements.push({ sql: `INSERT INTO mihon_sync_records(user_id,store,record_key,data,deleted,client_clock,device_id,revision)
      VALUES (?,?,?,?,?,?,?,(SELECT revision FROM mihon_sync_clock WHERE user_id=?))
      ON CONFLICT(user_id,store,record_key) DO UPDATE SET data=excluded.data,deleted=excluded.deleted,client_clock=excluded.client_clock,device_id=excluded.device_id,revision=excluded.revision
      WHERE excluded.client_clock>mihon_sync_records.client_clock OR (excluded.client_clock=mihon_sync_records.client_clock AND excluded.device_id>mihon_sync_records.device_id)`,
      args: [userId, change.store, change.key, change.data === null ? null : JSON.stringify(change.data), Number(change.deleted), change.clock, change.deviceId, userId] });
  }
  await client.batch(statements, 'write');
}

export async function pullChanges(client: Client, userId: string, cursor: number, includePreferences = true) {
  const [clock, result] = await client.batch([
    { sql: 'SELECT revision FROM mihon_sync_clock WHERE user_id=?', args: [userId] },
    { sql: `WITH candidates AS (SELECT store,record_key,data,deleted,client_clock,device_id,revision
      FROM mihon_sync_records WHERE user_id=? AND revision>? AND (? OR store<>'libraryPreferences') ORDER BY revision LIMIT 1000),
      page AS (SELECT *, SUM(length(CAST(COALESCE(data,'') AS BLOB))+3*length(CAST(record_key AS BLOB))+320) OVER (ORDER BY revision) AS page_bytes,
      ROW_NUMBER() OVER (ORDER BY revision) AS position FROM candidates)
      SELECT store,record_key,data,deleted,client_clock,device_id,revision FROM page WHERE page_bytes<=1048576 OR position=1 ORDER BY revision`, args: [userId, cursor, Number(includePreferences)] },
  ], 'read');
  const changes: RemoteChange[] = result.rows.map(row => ({
    id: String(row.store) + '\u0000' + String(row.record_key), store: String(row.store) as RemoteChange['store'], key: String(row.record_key),
    data: row.data === null ? null : JSON.parse(String(row.data)), deleted: !!row.deleted, clock: Number(row.client_clock), deviceId: String(row.device_id), revision: Number(row.revision),
  }));
  const highWater = Number(clock.rows[0]?.revision ?? 0);
  const hasMore = changes.length > 0 && changes.at(-1)!.revision < highWater;
  return { changes, cursor: hasMore ? changes.at(-1)!.revision : highWater, hasMore };
}
