# Mihon iOS PWA — implementation state

Updated 2026-11-10. Implementation is complete and validated below. The user requested committing and pushing these changes to `origin/main`. Deployment status has not been verified.

## Objective and accepted constraints

Improve the existing PWA using Mihon Android as the reference, with usable backup migration, source connections, and offline chapter downloads. The named `app.mihon_2026-11-07_15-00.tachibk` is a 0-byte placeholder. The user confirmed that the original is unavailable and asked to continue against the open source repository. No personal library was imported or verified.

Reference versions:

- Mihon commit `524fa53043f2f5b2321ea13027e44f093ab4245c`.
- Suwayomi source reference `d5215280158b9b78d2e3ca46312e39dccde6b97b`.
- Live API validation against Suwayomi **v2.4.2366**, using the official JAR with verified SHA-256 `af9feb20af9d7ebe9e30769e6c6ebc7fc7ab1c447388d42e0280b1da5fe07bfd`.

## Implemented

### Migration and storage

- Exact signed 64-bit source/tracker IDs, packed/unpacked category memberships, bookmarks, history duration, scanlators, notes, flags, preferences, memos, and extension store metadata.
- Category memberships resolve by `category.order`, matching Mihon's backup creator, including collisions between IDs and orders.
- Worker parsing with native/bundled gzip support, import preview, and transactional merge restoration. Newer local progress and deliberate unread marks survive repeated imports.
- Original archives retained by SHA-256 as typed bytes in IndexedDB to avoid WebKit's file-backed Blob cloning failures. Legacy Blob archives remain readable.
- IndexedDB version 4 preserves existing stores and adds categories, archives, metadata, download queue, backend bindings, and a history-by-manga index.
- JSON v2 exports metadata, settings, original archives, extension code, and download manifests. Images are separate CBZ files. JSON v1 remains readable; restored code is not activated unless selected.

### Sources and proxy

- Built-in MangaDex with language and data-saver settings, plus a local sample source and installable web extensions.
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
- Purple Material styling, safe-area handling, PWA/Apple PNG icons, cached app shell and worker, and an explicit app-update prompt.

### Setup

`README.md`, `docs/SUWAYOMI.md`, and `/help/suwayomi.html` explain migration, source setup, chapter transfer, exports, installation, and practical iOS limits. Connections opens the real setup guide.

`.env.example`, `Dockerfile`, `.dockerignore`, `compose.yaml`, `Caddyfile`, and `vercel.json` provide Node/Docker, optional trusted HTTPS, and serverless routing configuration. `npm start` reads `.env` if present. Node 22.18+ is required; the Docker app image uses Node 24.

## Final validation

| Check | Result |
| --- | --- |
| `npm test` | **44 passed**, 10 files. Covers backup/storage transactions, exact identities, migrations, image validation, local files, queue recovery, updates, source providers, full-body cancellation, stale backend IDs, proxy cleanup, and serverless bodies. |
| `npm run build` | Passed TypeScript and production build. Service worker generated with **24 precache entries**, approximately **514 KiB**. |
| `npm run test:e2e` | **12 passed**, six each in mobile Chromium and WebKit. Covers preview/restore, multiple categories, chapter attachment, downloads, offline reload, offset resume, last-page behavior, navigation, source failure isolation, and class extension installation/offline restart. |
| `npm run test:server` | Passed against the disposable live Suwayomi server, including Basic auth through the bundled proxy. Restores a synthetic archive, resolves original URLs, fetches/downloads PNG pages, disconnects, and verifies cached pages/bookmarks. |
| Additional live browser checks | Chromium and WebKit both connected with Basic auth, restored an original archive through the UI/proxy, downloaded a chapter, and reloaded its reader offline. |
| Visual review | Migrated library, download manager, and offline reader screenshots inspected. |
| Proxy longevity | Remained healthy after cancellation checks and the previous timeout window. |
| Setup verification | Compose YAML structure, package/lock version, Vercel rewrite, and HTTP-served help page checked. |
| `git diff --check` | Clean. |
| Runtime dependency audit | No production dependency findings. Four low build-tool findings remain through `deepmerge`; no patched current release was available. Vulnerable glob/minimatch versions were replaced via the Workbox override. |

The browser extension test serves a per-project fixture from `dist/__test/` and removes its own files afterward. This avoids WebKit route-mocking races once the service worker controls requests. Fixture data includes no personal library or manga files.

The build's ineffective dynamic-import warning is informational: `db.ts` dynamically imports downloads, which is also imported statically by other app modules. It does not prevent the build or offline operation.

## Verification limits

- The actual personal backup is unavailable.
- Physical iPhone installation, storage eviction, and background suspension behavior were not tested. iOS may suspend background downloads and evict local browser data; the queue resumes when reopened and exports remain necessary.
- Live server tests use Suwayomi's local source with synthetic PNG chapter files. Arbitrary third-party extensions and their remote endpoints were not exhaustively exercised.
- Tracking records are retained/viewable; live tracker authentication/synchronization is not implemented.
- Docker/Caddy container startup and an actual Vercel deployment were not executed. Docker was unavailable; configuration and the equivalent local Node server were checked.
- Full Android feature parity is not claimed. Android APKs need a compatible Suwayomi server, and `.tachibk` images must be downloaded/imported separately.

Temporary test servers and browser sessions were stopped. The production build was generated locally. In a fresh checkout, run `npm ci` and `npm run build` before `npm start`; follow `docs/SUWAYOMI.md` for an installed iPhone and compatible Android sources.
