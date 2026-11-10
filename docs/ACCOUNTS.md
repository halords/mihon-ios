# Accounts and automatic sync with Turso

Sign in to the same account on each device under **More → Account & sync**. The app keeps its offline database and automatically uploads local changes while online. It checks for changes from other devices every ten seconds and on reconnect or returning to the app. Sync runs while the app is open; if iOS suspends or closes it, queued changes continue when it is reopened. A first sync may take longer for a large imported library.

Synced data includes library membership, categories, manga and chapter metadata, notes, read/unread state, bookmarks, last page, resume offsets and reading history. Library removals and history deletions sync too. The latest change to a record wins; ties use a stable device ID. Explicit unread marks can replace earlier read marks. Downloaded images, download jobs, original archives, device settings and extension code stay on the device.

Creating an account adds the existing device library to that new account. When signing into an existing account, the device switches to that account's saved profile. An unclaimed device library is preserved and can be added with **Add device library**. Account profiles are kept separately so signing into another account does not merge libraries. Signing out retains the current offline copy.

Import/export remain available. Current PWA JSON and Android `.tachibk` exports work as before. Original imported archives and usable offline download manifests are retained when the initial device library is added to an account. Sync provides device continuity; exported files remain useful for migration and independent recovery.

## Configure the server

Create a Turso database and a database auth token. Set these private environment variables on the app's server:

```dotenv
TURSO_DATABASE_URL=libsql://your-database-your-org.turso.io
TURSO_AUTH_TOKEN=your-database-token
```

For local development or `npm start`, put them in the Git-ignored `.env` file. For Vercel, set both in the project's server environment, then redeploy. Do not use `VITE_` names: the browser never needs the database token.

```sh
npm run account:setup
npm run build
npm start
```

The setup command creates only the `mihon_users`, `mihon_sessions`, `mihon_sync_clock`, `mihon_sync_records` and `mihon_auth_limits` tables and their indexes, using `IF NOT EXISTS`. The API also initializes these tables on first use. Existing source adapters work without account configuration. Node, Vite development/preview and Vercel all serve `/api/account`.

Serve the app through trusted HTTPS for use across devices. Production sessions use an HttpOnly, Secure, SameSite cookie. `ACCOUNT_PUBLIC_ORIGIN` can optionally pin the allowed site origin; otherwise account write requests must match the request host. The app does not enable cross-origin account access.

## Account security and recovery

Accounts use email as a login identifier and a password of at least 12 characters. Passwords are salted and hashed with scrypt. Random session tokens are stored as hashes and expire after 30 days. API requests derive the user from the session and restrict every database query to that user. Write requests require a same-origin JSON request and a custom header. Login, registration and recovery attempts are limited.

A recovery code is shown once when an account is created. Save it outside the app. **Forgot your password?** accepts the email and recovery code to set a new password, revoke previous sessions and issue a new recovery code. No email-delivery provider is required; this version does not send verification or password-reset emails.

## Validation

```sh
npm test
npm run build
npm run test:e2e
npm run test:sync
```

The sync browser suite uses a disposable local libSQL database with the same schema and queries as Turso. It verifies two-device automatic syncing, offline unread changes across a cold reload, library removals, history retention, original archives, account isolation and retained exports in mobile Chromium and WebKit. Unit tests cover auth sessions, recovery, user isolation, stale changes, pagination and transactional sync queues.

On 2026-11-10, these four browser cases also passed against the configured live Turso database through the local Node server, then against the production app at `https://mihon-ios.vercel.app`. Disposable test accounts were removed after each run. Physical iPhone background suspension remains outside browser automation coverage.
