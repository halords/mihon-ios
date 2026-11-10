import { mkdir } from 'node:fs/promises';
await mkdir('.lane-out', { recursive: true });
// Disposable local libSQL database; the same schema/queries run on Turso.
process.env.TURSO_DATABASE_URL = 'file:.lane-out/account-e2e-' + process.pid + '.sqlite';
delete process.env.TURSO_AUTH_TOKEN;
process.env.PORT = '4176'; process.env.HOST = '127.0.0.1';
await import('../server/index.mjs');
