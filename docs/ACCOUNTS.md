# Accounts and automatic sync with Turso

Sign in to the same account on each device under **More → Account & sync**. The app keeps its offline database and automatically uploads local changes while online. It checks for changes from other devices every ten seconds and on reconnect or returning to the app. Sync runs while the app is open; if iOS suspends or closes it, queued changes continue when it is reopened. A first sync may take longer for a large imported library.

Synced data includes library membership, sorting and direction, grid/list view, random-order seed, category order, manga and chapter metadata, notes, read/unread state, bookmarks, last page, resume offsets and reading history. Library removals and history deletions sync too. The latest change to a record wins; ties use a stable device ID. Explicit unread marks can replace earlier read marks. Downloaded images, download jobs, original archives, other device settings and extension code stay on the device.

Creating an account adds the existing device library to that new account. First login to an account that has never uploaded library or reading data also adds the device's library, history and arrangement automatically. When signing into an account with saved reading data, the device switches to that account's saved profile and downloads its cloud changes. An unclaimed device library is preserved and can be added with **Add device library**. Account profiles are kept separately so signing into another account does not merge libraries. Signing out retains the current offline copy.

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

Accounts accept a username (3–40 letters, numbers, dots, dashes or underscores) or email, and a password of at least 8 characters. Passwords use Argon2id v1.3 with a random 16-byte salt, 64 MiB memory, three passes, one lane and a 32-byte output. Existing scrypt password hashes are verified and automatically upgraded on successful login. Random session tokens are stored as hashes and have no server expiry. Signing out revokes the current token; password recovery revokes previous tokens. API requests derive the user from the session and restrict every database query to that user. Write requests require a same-origin JSON request and a custom header. Login, registration and recovery attempts are limited.

The persistent HttpOnly cookie is refreshed on authenticated requests. Its lifetime is set to 400 days, the browser cookie limit, and active use renews that period. Browsers can still remove cookies or app storage, or expire a cookie after prolonged inactivity; the server cannot override those browser decisions. The legacy `expires_at` database column is retained for compatibility and set to zero for new tokens; it is not used to expire sessions.

Argon2id protects stored passwords through hashing. HTTPS encrypts traffic between devices, the app server and Turso. Library/history records are stored as JSON in the database, protected by account authorization and the server-only database token. This app does not implement end-to-end encryption of library/history; the server and database administrator can access these records.

A recovery code is shown once when an account is created. Save it outside the app. **Forgot your password?** accepts the username/email and recovery code to set a new password, revoke previous sessions and issue a new recovery code. No email-delivery provider is required; this version does not send verification or password-reset emails.

## Validation

```sh
npm test
npm run build
npm run test:e2e
npm run test:sync
```

The six-case sync browser suite uses a disposable local libSQL database with the same schema and queries as Turso. It verifies two-device automatic syncing, offline unread changes across a cold reload, library removals, history retention, original archives, account isolation, retained exports, first-login adoption, arrangement and unfinished reading position in mobile Chromium and WebKit. Unit tests cover Argon2id/legacy upgrades, non-expiring sessions, recovery, user isolation, stale changes, pagination and transactional sync queues.

On 2026-11-10, the original four browser cases passed against live Turso through Node and the production host. All six current hosted cases were then verified at `https://mihon-ios.vercel.app`; the final WebKit first-login case was retried successfully after removing bootstrap/test signup-limit state. Disposable test accounts were removed after each run. Physical iPhone background suspension remains outside browser automation coverage.
