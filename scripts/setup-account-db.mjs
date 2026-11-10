import { accountClient, initializeAccounts } from '../server/accountDatabase.ts';
const client = accountClient();
if (!client) throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env before setting up accounts.');
try { await initializeAccounts(client); console.log('Mihon account and sync tables are ready.'); }
finally { client.close(); }
