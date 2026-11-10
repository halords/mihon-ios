# Mihon iOS PWA — implementation state

Updated 2026-11-10. The current task adds visible library sorting, Mihon extension management in Browse and current-state `.tachibk` export, using the user's APK and original backup as references. The user authorized committing and pushing the verified changes to GitHub. Deployment status has not been verified.

## Objective and accepted constraints

Improve the existing PWA using Mihon Android as the reference, with usable backup migration, source connections, and offline chapter downloads. The repository backup is a 0-byte placeholder. The user subsequently supplied `Downloads/mihon-v0.21.3.apk` and the original `app.mihon_2026-11-07_15-00_0_814q.tachibk`. The original parses into 310 manga records, 146 favorites, 60,192 chapters, 55,374 read chapters and 19,965 history records, with nine source IDs and Keiyoushi/Yūzōnō stores. Its saved sort is `LAST_READ,DESCENDING`. The APK contains no bundled extension APKs. Inspection scripts, downloaded references and personal files stay outside Git.

Reference versions:

- Mihon commit `524fa53043f2f5b2321ea13027e44f093ab4245c`.
- Supplied Mihon v0.21.3 APK; matching v0.21.3 LibrarySortMode, LibraryViewModel and BackupExtensionStore source declarations.
- Suwayomi source reference `d5215280158b9b78d2e3ca46312e39dccde6b97b`.
- Live API validation against Suwayomi **v2.4.2366**, using the official JAR with verified SHA-256 `af9feb20af9d7ebe9e30769e6c6ebc7fc7ab1c447388d42e0280b1da5fe07bfd`.

## Implemented

### Migration and storage

- Exact signed 64-bit source/tracker IDs, packed/unpacked category memberships, bookmarks, history duration, scanlators, notes, flags, preferences, memos, and extension store metadata.
- Category memberships resolve by `category.order`, matching Mihon's backup creator, including collisions between IDs and orders.
- Worker parsing with native/bundled gzip support, import preview, and transactional merge restoration. Newer local progress and deliberate unread marks survive repeated imports.
- Restoring matching preferences now applies `library_sorting_mode`, including explicit direction. Legacy PWA reverse-order settings migrate without changing their displayed order.
- New gzip/protobuf `.tachibk` export uses Mihon v0.21.3 field declarations and the PWA's current library membership, chapter state, history, category memberships and sort/reader preferences. Exact source/tracker IDs, retained tracking/notes/memos/source preferences/stores remain portable. Migrated titles use their current source/URL. Browser-only library sources produce an actionable error rather than silent omissions. Original archives stay unchanged; images remain separate CBZ files.
- Restore preloads previous state/history and queues native chapter/history writes in the same atomic transaction, retaining rollback and newer-state merge behavior while reducing per-record JavaScript requests.
- Original archives retained by SHA-256 as typed bytes in IndexedDB to avoid WebKit's file-backed Blob cloning failures. Legacy Blob archives remain readable.
- IndexedDB version 4 preserves existing stores and adds categories, archives, metadata, download queue, backend bindings, and a history-by-manga index.
- JSON v2 exports metadata, settings, original archives, extension code, and download manifests. Images are separate CBZ files. JSON v1 remains readable; restored code is not activated unless selected.

### Sources and proxy

- Built-in MangaDex with language and data-saver settings, plus a local sample source and installable web extensions.
- Browse has Sources/Extensions/Titles sections, source search/language filtering, and exact IDs for unavailable library sources. Mihon and web extensions have separate panels.
- Suwayomi extension catalog pagination, saved-store quick-add, custom HTTPS stores, language/status filters, install/update/uninstall and automatic registry refresh use the v2.4.2366 API. Existing web extensions remain supported.
- Suwayomi source discovery, exact source/URL lookup, manga/chapter refresh, image retrieval, Basic authentication, retained source lists, and original-backup upload/status polling.
- Stable-compatible GraphQL input types and top-level upload variables: Suwayomi's multipart parser does not support mapping nested upload fields.
- Persisted backend IDs are revalidated by source and original URL. Thumbnail cache identities include the source/title identity so reused server IDs cannot mix covers.
- Independent builtin/extension/Suwayomi registry providers. Removing a provider reveals the previous adapter. Class extension instances preserve prototype methods and private state; relative indexes work.
- Shared dev/preview/production/Vercel proxies, same-origin session/CSRF cookie forwarding, parsed serverless request-body support, bounded backup uploads, streaming backpressure, and client cancellation.
- Upstream timeout timers are released after requests; late stream errors cannot crash the proxy after a browser abandons an image.
- Custom proxy templates and image routing without double proxying or rewriting the configured backend URL.

### Downloads and reader

- Persistent queue with pause/resume/cancel/retry, interrupted-job recovery, Web Locks, BroadcastChannel updates, and a foreground wake lock where supported.
- Request timeouts/cancellation remain active through the entire response body, including source resolution before chapter page requests.
- Image signature checks, browser decoding/dimensions, page identity hashes, complete-cache validation, and startup reconciliation of missing pages.
- CBZ/ZIP chapter imports with natural page ordering and image validation. Replacements stage pages and commit metadata/progress/manifests atomically. Ambiguous chapter-number matches are rejected.
- Downloaded pages load without a source or server. Cached Blob URLs are created near the viewport and released away from it.
- Continuous vertical reading, LTR/RTL paging, zoom, fit controls, bookmarks, seeking, swipe/keyboard controls, offset resume, last-page visibility, and lifecycle progress saves.
- Library, categories, browse, details, history, updates, settings, backup, migration, connections, and download-manager screens rebuilt around the reading/migration workflows.
- Visible library sort with newest-first Last read, alphabetical, unread/total chapters, added/update/upload/fetch dates and seeded random order. Equal values sort alphabetically; fully read titles stay last when sorting unread count.
- Purple Material styling, safe-area handling, PWA/Apple PNG icons, cached app shell and worker, and an explicit app-update prompt.

### Setup

`README.md`, `docs/SUWAYOMI.md`, and `/help/suwayomi.html` explain migration, source setup, chapter transfer, exports, installation, and practical iOS limits. Connections opens the real setup guide.

`.env.example`, `Dockerfile`, `.dockerignore`, `compose.yaml`, `Caddyfile`, and `vercel.json` provide Node/Docker, optional trusted HTTPS, and serverless routing configuration. `npm start` reads `.env` if present. Node 22.18+ is required; the Docker app image uses Node 24.

## Final validation

| Check | Result |
| --- | --- |
| `npm test` | **56 passed**, 13 files. Adds sorting/direction migration, Android preference restore, extension catalog pagination/actions/authentication/errors and protobuf export tests to the existing migration/reader/storage coverage. |
| `npm run build` | Passed TypeScript and production build. Service worker generated with **24 precache entries**, approximately **539 KiB**. |
| `npm run test:e2e` | **20 passed**, ten each in mobile Chromium and WebKit. Includes all prior flows plus visible sorting, persisted order, retained stores, extension installation/update/removal/filtering and generated Android backup download/re-preview. |
| `npm run test:server` | Passed against disposable live Suwayomi v2.4.2366 through the bundled proxy, now restoring a **newly generated PWA `.tachibk`**. Resolves original URLs, fetches/downloads PNG pages, disconnects, and verifies cached pages/bookmarks. Previous Basic-auth proxy checks remain applicable. |
| Live extension catalog | Keiyoushi exposed **1,554** extensions. Installed its English MangaHub extension, verified source ID **4758858684982406533** matches the real backup and appears in Browse, then uninstalled it from the disposable server. The retained Yūzōnō URL returned 404; the UI now gives a short actionable error. |
| Android export UI | Chromium and WebKit downloaded a generated `.tachibk`, parsed its counts, and re-opened it in the backup preview. |
| Real backup round trip | Chromium restored the supplied backup, verified counts/order/reload, then generated a new `.tachibk` retaining all 310 manga, 146 favorites and 60,192 chapters. Restore/order verification took about 28 seconds after batching. |
| Additional live browser checks | Chromium and WebKit both connected with Basic auth, restored an original archive through the UI/proxy, downloaded a chapter, and reloaded its reader offline. |
| Visual review | Migrated library, download manager, and offline reader screenshots inspected. |
| Proxy longevity | Remained healthy after cancellation checks and the previous timeout window. |
| Setup verification | Compose YAML structure, package/lock version, Vercel rewrite, and HTTP-served help page checked. |
| `git diff --check` | Clean. |
| Runtime dependency audit | No production dependency findings. Four low build-tool findings remain through `deepmerge`; no patched current release was available. Vulnerable glob/minimatch versions were replaced via the Workbox override. |

The browser extension test serves a per-project fixture from `dist/__test/` and removes its own files afterward. This avoids WebKit route-mocking races once the service worker controls requests. Fixture data includes no personal library or manga files.

The build's ineffective dynamic-import warning is informational: `db.ts` dynamically imports downloads, which is also imported statically by other app modules. It does not prevent the build or offline operation.

## Verification limits

- The actual personal backup was parsed and restored in isolated Chromium verification, with all 310 manga, 146 favorites, 60,192 chapters and 19,965 history entries. Newest-read order matches the original and survives reload. Full restore in the **Windows WebKit port** exceeded the three-minute verification timeout: an independent 5,000-record IndexedDB write benchmark takes about 77 seconds, both inside and outside the sandbox. Functional WebKit restore/export tests pass on smaller fixtures. Physical iPhone performance remains untested; no claim of real-backup completion on iPhone is made.
- Physical iPhone installation, storage eviction, and background suspension behavior were not tested. iOS may suspend background downloads and evict local browser data; the queue resumes when reopened and exports remain necessary.
- Live server tests use Suwayomi's local source with synthetic PNG chapter files. Arbitrary third-party extensions and their remote endpoints were not exhaustively exercised.
- Tracking records are retained/viewable; live tracker authentication/synchronization is not implemented.
- Docker/Caddy container startup and an actual Vercel deployment were not executed. Docker was unavailable; configuration and the equivalent local Node server were checked.
- Full Android feature parity is not claimed. Android APKs need a compatible Suwayomi server, and `.tachibk` images must be downloaded/imported separately.

Temporary test servers and browser sessions were stopped. The production build was generated locally. In a fresh checkout, run `npm ci` and `npm run build` before `npm start`; follow `docs/SUWAYOMI.md` for an installed iPhone and compatible Android sources.
