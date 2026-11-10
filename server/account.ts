import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash as argonHash, verify as argonVerify, type Options } from '@node-rs/argon2';
import type { Client } from '@libsql/client';
import { accountClient, initializeAccounts, pullChanges, pushChanges } from './accountDatabase.ts';
import { validChange, type AccountUser } from '../src/lib/syncTypes.ts';

const derive = promisify(scrypt);
const ARGON_POLICY = { algorithm: 2, version: 1, memoryCost: 65536, timeCost: 3, parallelism: 1, outputLen: 32 } as const satisfies Options; // Argon2id v1.3
let dummyPasswordHash: Promise<string> | undefined;
const SESSION_COOKIE_SECONDS = 400 * 86400;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
class AccountError extends Error { readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
async function passwordHash(password: string): Promise<string> {
  // The library generates a fresh 16-byte salt and returns an encoded PHC hash.
  return argonHash(password, ARGON_POLICY);
}
async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  if (encoded.startsWith('$argon2id$')) {
    try { return await argonVerify(encoded, password); } catch { return false; }
  }
  // Existing accounts keep working and upgrade after their next valid login.
  const [salt, digest] = encoded.split(':');
  if (!salt || !/^[a-f0-9]{32}$/.test(salt) || !digest || !/^[a-f0-9]{128}$/.test(digest)) return false;
  return timingSafeEqual(await derive(password, salt, 64) as Buffer, Buffer.from(digest, 'hex'));
}
function loginName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) || /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(value.trim()))) throw new AccountError('Enter a username (3–40 characters) or a valid email address.');
  return value.trim().toLowerCase();
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value) > 256) throw new AccountError('Use a password with at least 8 characters, up to 256 bytes.');
  return value;
}
function cookieToken(req: IncomingMessage): string {
  const token = /(?:^|;\s*)mihon_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}
function sessionCookie(req: IncomingMessage, token: string, clear = false): string {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host ?? '');
  return `mihon_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_COOKIE_SECONDS}${local ? '' : '; Secure'}`;
}
function write(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['x-mihon-request'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) throw new AccountError('Unsupported account request.', 403);
  if (req.headers.origin) {
    let origin: URL;
    try { origin = new URL(req.headers.origin); } catch { throw new AccountError('Invalid request origin.', 403); }
    const configured = process.env.ACCOUNT_PUBLIC_ORIGIN;
    if (configured ? origin.origin !== new URL(configured).origin : origin.host !== req.headers.host) throw new AccountError('Invalid request origin.', 403);
  }
  // Vercel may already parse the body; enforce the same size limit there.
  const supplied = (req as IncomingMessage & { body?: unknown }).body;
  let raw: string;
  if (supplied !== undefined) raw = typeof supplied === 'string' ? supplied : JSON.stringify(supplied);
  else {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 4 * 1024 * 1024) throw new AccountError('Sync request is too large.', 413);
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new AccountError('Sync request is too large.', 413);
  try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new AccountError('Invalid account request.'); }
}

export function createAccountHandler(supplied?: Client) {
  let client = supplied;
  let initialized: Promise<void> | undefined;
  const limit = async (purpose: string, identity: string, max = 15) => {
    const now = Date.now();
    const result = await client!.execute({ sql: `INSERT INTO mihon_auth_limits(bucket,count,reset_at) VALUES (?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count`,
      args: [hash(purpose + ':' + identity), now + 15 * 60000, now, now] });
    if (Number(result.rows[0]?.count) > max) throw new AccountError('Too many attempts. Try again in 15 minutes.', 429);
  };
  const user = async (req: IncomingMessage, res: ServerResponse): Promise<AccountUser | null> => {
    const token = cookieToken(req);
    if (!token) return null;
    const result = await client!.execute({ sql: `SELECT u.id,u.email FROM mihon_sessions s JOIN mihon_users u ON u.id=s.user_id WHERE s.token_hash=?`, args: [hash(token)] });
    // Sessions have no server expiry. Renew the persistent HttpOnly cookie on
    // use because browsers cap the lifetime of any individual cookie.
    if (result.rows[0]) res.setHeader('Set-Cookie', sessionCookie(req, token));
    return result.rows[0] ? { id: String(result.rows[0].id), email: String(result.rows[0].email) } : null;
  };
  const signIn = async (req: IncomingMessage, res: ServerResponse, account: AccountUser, recoveryCode?: string, verifiedPasswordHash?: string) => {
    const token = randomBytes(32).toString('hex');
    const result = await client!.batch([
      verifiedPasswordHash
        ? { sql: 'INSERT INTO mihon_sessions(token_hash,user_id,expires_at) SELECT ?,id,0 FROM mihon_users WHERE id=? AND password_hash=?', args: [hash(token), account.id, verifiedPasswordHash] }
        : { sql: 'INSERT INTO mihon_sessions(token_hash,user_id,expires_at) VALUES (?,?,0)', args: [hash(token), account.id] },
    ], 'write');
    if (result[0]!.rowsAffected !== 1) throw new AccountError('Invalid username/email or password.', 401);
    const synced = await client!.execute({ sql: "SELECT 1 FROM mihon_sync_records WHERE user_id=? AND store IN ('library','history','manga','chapterMeta','chapterState') LIMIT 1", args: [account.id] });
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    write(res, 200, { configured: true, user: account, hasSyncedData: synced.rows.length > 0, ...(recoveryCode ? { recoveryCode } : {}) });
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      client ??= accountClient() ?? undefined;
      const action = new URL(req.url ?? '/', 'http://localhost').searchParams.get('action') ?? 'status';
      if (!client) { write(res, action === 'status' ? 200 : 503, { configured: false, user: null, error: 'Online accounts are not configured on this server yet.' }); return; }
      initialized ??= initializeAccounts(client).catch(error => { initialized = undefined; throw error; });
      await initialized;
      if (req.method === 'GET' && action === 'status') { write(res, 200, { configured: true, user: await user(req, res) }); return; }
      if (req.method === 'GET' && action === 'pull') {
        const account = await user(req, res); if (!account) throw new AccountError('Sign in to sync your library.', 401);
        if (req.headers['x-mihon-account'] !== account.id) throw new AccountError('The signed-in account changed. Reconnect to continue syncing.', 409);
        const cursor = Number(new URL(req.url!, 'http://localhost').searchParams.get('cursor') ?? 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new AccountError('Invalid sync cursor.');
        write(res, 200, await pullChanges(client, account.id, cursor, req.headers['x-mihon-sync-version'] === '2')); return;
      }
      if (req.method !== 'POST') throw new AccountError('Unsupported account request.', 405);
      const input = await body(req);
      if (action === 'register') {
        const address = loginName(input.username ?? input.email); const secret = password(input.password);
        await limit('register', req.socket.remoteAddress ?? 'unknown', 8);
        const id = randomUUID(); const recovery = randomBytes(24).toString('hex');
        try { await client.execute({ sql: 'INSERT INTO mihon_users(id,email,password_hash,recovery_hash,created_at) VALUES (?,?,?,?,?)', args: [id, address, await passwordHash(secret), hash(recovery), Date.now()] }); }
        catch (error) { if (String((error as { code?: string }).code).includes('CONSTRAINT')) throw new AccountError('An account with that username or email already exists.', 409); throw error; }
        await signIn(req, res, { id, email: address }, recovery); return;
      }
      if (action === 'login') {
        const address = loginName(input.username ?? input.email);
        if (typeof input.password !== 'string' || Buffer.byteLength(input.password) > 256) throw new AccountError('Invalid email or password.', 401);
        await limit('login', address);
        const result = await client.execute({ sql: 'SELECT id,email,password_hash FROM mihon_users WHERE email=?', args: [address] });
        const record = result.rows[0];
        let encoded = String(record?.password_hash ?? await (dummyPasswordHash ??= passwordHash(randomBytes(32).toString('hex'))));
        if (!await passwordMatches(input.password, encoded) || !record) throw new AccountError('Invalid email or password.', 401);
        if (!encoded.startsWith('$argon2id$')) {
          const upgraded = await passwordHash(input.password);
          const result = await client.execute({ sql: 'UPDATE mihon_users SET password_hash=? WHERE id=? AND password_hash=?', args: [upgraded, String(record.id), encoded] });
          if (result.rowsAffected !== 1) throw new AccountError('Invalid email or password.', 401);
          encoded = upgraded;
        }
        await signIn(req, res, { id: String(record.id), email: String(record.email) }, undefined, encoded); return;
      }
      if (action === 'recover') {
        const address = loginName(input.username ?? input.email); const secret = password(input.password);
        await limit('recover', address, 8);
        const result = await client.execute({ sql: 'SELECT id,email,recovery_hash FROM mihon_users WHERE email=?', args: [address] });
        const record = result.rows[0];
        if (!record || typeof input.recoveryCode !== 'string' || hash(input.recoveryCode.trim()) !== record.recovery_hash) throw new AccountError('Invalid email or recovery code.', 401);
        const recovery = randomBytes(24).toString('hex');
        await client.batch([
          { sql: 'UPDATE mihon_users SET password_hash=?,recovery_hash=? WHERE id=?', args: [await passwordHash(secret), hash(recovery), String(record.id)] },
          { sql: 'DELETE FROM mihon_sessions WHERE user_id=?', args: [String(record.id)] },
        ], 'write');
        await signIn(req, res, { id: String(record.id), email: String(record.email) }, recovery); return;
      }
      const account = await user(req, res); if (!account) throw new AccountError('Sign in to sync your library.', 401);
      if (req.headers['x-mihon-account'] !== account.id) throw new AccountError('The signed-in account changed. Reconnect to continue syncing.', 409);
      if (action === 'logout') {
        await client.execute({ sql: 'DELETE FROM mihon_sessions WHERE token_hash=?', args: [hash(cookieToken(req))] });
        res.setHeader('Set-Cookie', sessionCookie(req, '', true)); write(res, 200, { user: null }); return;
      }
      if (action === 'push') {
        if (!Array.isArray(input.changes) || input.changes.length > 4000 || !input.changes.every(validChange)) throw new AccountError('Invalid library sync records.');
        await pushChanges(client, account.id, input.changes); write(res, 200, { saved: input.changes.length }); return;
      }
      throw new AccountError('Unsupported account request.', 404);
    } catch (error) {
      if (error instanceof AccountError) write(res, error.status, { error: error.message });
      else { console.error('Account database request failed:', (error as { code?: string }).code ?? 'unavailable'); write(res, 503, { error: 'Account sync is temporarily unavailable. Your changes are saved on this device.' }); }
    }
  };
}
export const handleAccount = createAccountHandler();
