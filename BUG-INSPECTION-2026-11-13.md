# Bug inspection — Mihon iOS PWA — 2026-11-13

INSPECT ONLY. No source files were modified, no commits, no pushes, no deploys.
Local HEAD at inspection: `3fcbb76` (move-to-top correction, 2026-11-12).
The only tree modification during inspection was `STATE.md` (the parallel
fast-scroller subagent's own updates — 6 insertions at start, 8 by the end).
No source file changed while the suite ran, so the baseline below is clean.

## Test suite (run first, before any other work)

`npm test` — **136 passed / 1 failed (137 total)**, identical to the
136/137 baseline. The single failure is the known pre-existing one:

- `tests/browserBackend.test.ts` — "keeps a user-operated browser session…"
  fails because it needs the live VPS browser service
  (`"The browser could not access this source. Open verification, or check
  the website and VPS browser service."`). Fails identically on a pristine
  tree; not a regression. No live-bot/VPS work was attempted.

## Live deployment check (public fetch only, no Vercel connector)

`https://mihon-ios.vercel.app` serves the current build:

- Served `index.html` references `assets/index-BsgnepxM.js` and
  `assets/index-CYrO7FtT.css` — the same names as the local `dist/`
  (built 2026-11-12 13:09 UTC, after HEAD `3fcbb76` at 09:20 UTC).
- Downloaded served JS bundle is **byte-identical** to
  `dist/assets/index-BsgnepxM.js` (518,883 bytes, `cmp` clean).
- Served `sw.js` is **byte-identical** to local `dist/sw.js` and precaches
  the same `index-BsgnepxM.js`.
- Marker grep of the served bundle: `chapter-progress` present (2 hits),
  `library-added`/`library-removed` present, `mihon:sync-dirty`,
  `by-pending`, `calmDownloads`, `deleteReadDownloads` present;
  **`title-opened` absent (0 hits)** — the move-to-top correction is live.

## Recent-change regression review (verified clean)

- **Move-to-top correction (3fcbb76):** `title-opened` is gone from the
  whole codebase (grep: zero hits in `src/` and `tests/`). The only
  emitters of `chapter-progress` are the reader (after a *successful*
  progress save, `ReaderPage.tsx:150`) — a chapter that fails to load
  saves nothing and bumps nothing. Stale progress can't drag a title
  back (`Math.max(item.lastRead, …)` in `libraryData.ts`). Details-page
  opens emit nothing (`nav.tsx` emissions deleted in the commit).
- **Live library updates (6f4e7f3):** event bus is a plain listener set
  (`libraryLive.ts`); patches serialize through a promise chain; patches
  recompute counts from the shared maps so re-application is harmless
  (idempotent). Sync pulls never emit — the only `emitLibraryLive` call
  sites are the reader and the details page, so background sync still
  never reshuffles the visible Library. The `library-added` sort.read =
  add-time trick keeps `lastRead` honest (0) so the Started filter is
  unaffected.
- **Open-time-only sync (b0f57e3):** confirmed — no `setInterval` anywhere
  in the sync path. The only two timers in the app are the reader 15 s
  heartbeat (`ReaderPage.tsx:205`) and the BrowserSourcesPanel 3 s poll
  while its verification panel is open. `mihon:sync-dirty` only sets an
  in-memory flag; sync runs on open, foreground, `online`, and
  best-effort on backgrounding.
- **Sync bulk path:** push batches byte-sized to 4,000 records / 3.5 MB;
  ack is scoped to the batch with the clock/device mid-flight guard;
  pull pages apply in one transaction per page; server upserts are
  idempotent, so a push whose response is lost re-pushes safely.
  Mid-sync drop and offline-open paths are handled (see findings for the
  remaining gaps).
- **Downloads force-through / retries / clear-queue:** page attempts 6
  with backoff, cache-bust on invalid-image failures, auto-retry with
  rate-limit-aware cooldowns, clear-queue deletes all job rows in one
  transaction with per-job isolated cleanup — all as specified. (One
  side effect of clear-queue is finding #3 below.)
- **Import-then-login adoption:** sign-in/recover always call
  `addDeviceLibrary()` after pulling cloud state; no-op without a guest
  snapshot.
- **Webtoon recycling:** remote pages now unmount their `<img>` when far
  (IntersectionObserver, 1000 px rootMargin) with aspect-ratio containers
  holding layout; paged mode untouched.
- **0-bytes Android picker fix:** `inspectTachibkFile` reads bytes first
  and judges emptiness by `raw.length`; intact.
- **Per-title restore:** one transaction per title, idempotent merges,
  archive written only in the final transaction. Intact.

---

## Findings (ranked by severity, then user impact)

### MAJOR

#### 1. Auto-delete (default ON) deletes a chapter's pages while the reader is still showing it — scrolling back shows broken pages
- **Severity:** major
- **Evidence:** `src/pages/ReaderPage.tsx:150` — every progress flush for
  a finished chapter chains `maybeAutoDeleteReadChapter`, which
  (`src/lib/downloads.ts:264-272`) deletes the download's cached pages
  immediately. `PageImage` blob-managed pages unload their blob URLs when
  far from the viewport and re-read from the cache on return
  (`ReaderPage.tsx:66-70`); a missing page throws `Downloaded page is
  missing` and renders the "Page could not load" error. Paged mode is
  the same: `imageLoaded` marks the chapter read the moment the last
  page loads, the flush auto-deletes, and "Return to last page" remounts
  `PageImage` against a deleted cache entry.
- **Repro:** download a chapter (default settings) → read to the end →
  scroll back up (webtoon) or tap "Return to last page" (paged) →
  previously fine pages now show "Page N could not load"; Retry fails
  the same way. Offline, the chapter can't even be re-opened.
- **Fix:** defer the auto-delete until the reader leaves the chapter
  (load-effect cleanup / navigation away), or make `PageImage` fall back
  to the remote `imageUrl` when its cached page is gone.

#### 2. Library snapshot is never invalidated by a backup restore or an account switch — Library shows stale (or wrong-profile) titles until manual refresh
- **Severity:** major
- **Evidence:** `src/pages/LibraryPage.tsx:20-42` — `useLibraryData`
  reloads only when the snapshot is null, via the refresh button, or
  after in-page actions; it subscribes to no data events.
  `setLibrarySnapshot` has no callers outside `LibraryPage`. Meanwhile
  `restoreTachibk` (`src/backup/tachibk.ts:272`) and
  `activateAccountProfile` (`src/lib/account.ts:155`) both
  `dispatchDataEvent()`, which Library ignores. After an account switch
  the Library shows the *previous profile's* titles, and tapping one
  errors (`loadMangaData` reads the live DB, where the title may not
  exist). After a restore, new titles are missing until refresh — the
  BackupPage "Open library" button lands on the stale snapshot.
- **Fix:** invalidate the snapshot on restore/profile-switch only (a
  distinct event or explicit `setLibrarySnapshot(null)` + reload in
  those two paths), preserving the deliberate rule that sync *pulls*
  never reshuffle the visible Library.

#### 3. "Clear queue" leaves downloads paused with no visible resume control — later downloads silently stall
- **Severity:** major
- **Evidence:** `clearDownloadQueue` (`src/lib/downloadQueue.ts`)
  calls `setDownloadsPaused(true)` at the start and never restores the
  previous state. `pump()` early-returns while paused, so newly
  enqueued chapters sit queued forever. The resume control is
  unreachable right after a clear: the DownloadsPage header
  pause/resume button only renders when `queue.jobs.length > 0`, and
  `QueueBar` returns null with no jobs — the paused flag persists in
  metadata until the user happens to notice "Downloads paused" after
  enqueueing something.
- **Fix:** capture `wasPaused` before pausing in `clearDownloadQueue`
  and restore it at the end (same pattern `connect()` already uses in
  `account.ts`).

#### 4. One invalid local sync record bricks all sync permanently — push throws before pull, the record stays pending, no recovery path
- **Severity:** major (rare trigger, total consequence)
- **Evidence:** `cycle()` (`src/lib/account.ts`, push loop) throws on
  the first record failing `validChange` ("A local record cannot be
  synced. Export your library and report this error."). The throw skips
  the pull loop entirely, the record stays `pending: 1`, and every
  subsequent open re-scans it via the by-pending index and throws again
  — sync is wedged with no in-app recovery. Plausible trigger: the
  128 KB `canonical(data)` cap in `validChange` on a manga record whose
  `mihon` payload (full backup record incl. tracking/notes) grows past
  the cap.
- **Fix:** quarantine the offending record (mark `pending: 0`, stash its
  id in metadata, surface a count on the Account page) and continue the
  batch instead of throwing.

### MINOR

#### 5. Mark-as-read/unread, download/delete-download from the details page, and background download completions don't patch the Library snapshot
- **Severity:** minor
- **Evidence:** `MangaDetailsPage.tsx` `markSelection`,
  `downloadSelection`, and the chapter-sheet actions (mark/bookmark/
  download/delete) never call `emitLibraryLive`; `downloadQueue.ts`
  has no libraryLive emission on job completion. Returning to the
  Library after marking chapters read on the details page (or after a
  bulk download finishes) shows stale unread/downloaded counts until a
  manual refresh — the same staleness class the Nov 12 live-update work
  fixed for the reader and add/remove. (LibraryPage's own bulk actions
  are fine — they call `reload()`.)
- **Fix:** emit a `chapter-progress`-style update (or a new
  `counts-changed` update reusing the same patch path) from those
  actions, or have LibraryPage reload on `mihon:downloads-changed`.

#### 6. HTTP 429 from a JSON API is not recognized as a rate limit — retries hammer at 5 s/15 s instead of 60 s/180 s
- **Severity:** minor
- **Evidence:** `fetchJson` (`src/lib/fetchJson.ts`) throws
  `Source rate limit reached. Try again shortly.` for 429 — no
  `HTTP 429` substring — while `isRateLimitMessage`
  (`src/lib/downloadQueue.ts`) only matches `HTTP 429` / `HTTP 503`.
  A 429 from `getPageList` (JSON path) therefore gets the short
  transient cooldowns.
- **Fix:** match `rate limit` (case-insensitive) in
  `isRateLimitMessage` as well.

#### 7. In vertical mode a chapter is never marked read if its last page fails to load
- **Severity:** minor
- **Evidence:** `updateVisible` (`src/pages/ReaderPage.tsx`) computes
  `complete` only when the last page's `<img>` exists, is complete, and
  has `naturalWidth > 0`. A failed last page renders the page-error UI
  (no `<img>`), so `complete` stays false forever. Paged mode has a
  fallback (paging past the end marks read); vertical mode has none.
- **Fix:** treat reaching the end sentinel / a failed last page as
  complete, or mark read when the reader-end element is visible.

#### 8. First sync materializes all ~141k pending records in memory before batching — jetsam risk on iOS
- **Severity:** minor
- **Evidence:** `cycle()` (`src/lib/account.ts`) collects every pending
  record into one `pending` array (full payloads — chapter metadata
  included) before the batch loop starts. On a phone, a 141k-record
  first sync holds on the order of 100 MB in JS heap while also running
  IndexedDB and network I/O.
- **Fix:** stream batches from the by-pending cursor (collect one
  4,000-record / 3.5 MB batch, send, ack, repeat) instead of
  materializing the whole pending set.

#### 9. Webtoon resume eagerly fetches every page above the resume point
- **Severity:** minor
- **Evidence:** `ReaderPage.tsx` renders `eager={index === 0 &&
  p <= Math.max(2, resumeTarget.current.page)}` — resuming at page 120
  mounts `<img loading="eager">` for pages 0–120 at once, fetching all
  of them and defeating the lazy recycling the heat pass built.
  Aspect-ratio containers already hold layout, so the above-viewport
  fetches buy nothing when the source supplies dimensions.
- **Fix:** cap the eager window to a few pages around the resume target
  (or apply it only when the source didn't supply page dimensions).

#### 10. AccountPage copy is stale after the open-time-only sync change
- **Severity:** minor
- **Evidence:** `src/pages/AccountPage.tsx` — "Sync happens
  automatically / Online changes upload automatically. Offline changes
  wait here until you reconnect." Since 2026-11-11, changes upload on
  app open / foreground / reconnect, not as they happen — the copy now
  over-promises and will read as broken sync to a user who edits on one
  device and checks the other mid-session.
- **Fix:** reword to "Changes upload when you open the app or reconnect."

#### 11. Retry-cooldown wait holds the Web Lock and wake lock and polls IndexedDB every 250 ms for up to 3 minutes
- **Severity:** minor
- **Evidence:** `waitForRetryDue` (`src/lib/downloadQueue.ts`) ticks
  every 250 ms calling `refresh(false)` (a full job re-read) until the
  earliest `notBefore` expires — up to 180 s for rate-limit retries —
  while `processQueue` still holds the `mihon-download-queue` Web Lock
  and the screen wake lock. Idle waiting with the screen held awake
  works against the heat-reduction pass.
- **Fix:** release the wake lock while waiting; sleep to the deadline
  with a single timer re-armed on queue changes instead of 250 ms
  polling.

#### 12. JSON import (`importData`) is still one transaction for the whole file — the all-or-nothing rollback the tachibk fix removed
- **Severity:** minor
- **Evidence:** `src/lib/db.ts` `importData` opens a single readwrite
  transaction over all stores and puts every record inside it; a killed
  or backgrounded tab mid-import rolls the entire import back. This is
  the exact failure mode `restoreTachibk` was restructured to avoid
  (per-title transactions, 2026-11-10). `addDeviceLibrary`
  (`account.ts`) — the sign-in adoption path — also goes through
  `importData`.
- **Fix:** chunk JSON imports per title like `restoreTachibk`, or
  document the single-transaction behavior as accepted for JSON.

#### 13. A download job for a removed title burns auto-retries instead of failing immediately
- **Severity:** minor
- **Evidence:** `downloadChapter`'s start-of-download removal error
  (`src/lib/downloads.ts`: "Add this title back to your library before
  downloading.") doesn't contain `removed from your library`, so it
  misses `NON_TRANSIENT_MESSAGES` (`src/lib/downloadQueue.ts`) and
  gets 2 auto-retries with cooldowns. (The mid-download removal error
  does match.) `enqueueChapters` also never checks the removal marker,
  so a job can be queued for a removed title from a stale page.
- **Fix:** add the removal message to the non-transient list (or check
  `isMangaDownloadRemoved` in `enqueueChapters`).

### NITS

#### 14. Sign-in runs up to three sync cycles back-to-back
- **Severity:** nit
- **Evidence:** `signInAccount` (`src/lib/account.ts`): `syncAccount()`
  before adoption, then `addDeviceLibrary()` (which calls
  `syncAccount()` itself at the end), then `syncAccount()` again.
  Same shape in `recoverAccount`.
- **Fix:** drop the trailing `syncAccount()` — adoption already syncs.

#### 15. Dead code: `getCachedChapterPages` / `resolveChapterPages` have no callers
- **Severity:** nit
- **Evidence:** grep finds no callers outside `src/lib/downloads.ts`
  itself. `getCachedChapterPages` creates a blob URL for *every* page
  of a chapter at once, so if it is ever wired up it will spike memory
  on long chapters.
- **Fix:** delete both, or wire a bounded caller.

#### 16. Paged zoom is 180%, not the documented 2×
- **Severity:** nit
- **Evidence:** `src/index.css` — `.reader-zoomed .paged-stage {
  width: 180% }`, while the build record describes double-tap zoom as
  2×.
- **Fix:** change to 200% or correct the docs.

#### 17. Plugin modules run with full app privileges (documented trust model — known risk, not a defect)
- **Severity:** nit (accepted design; flagging for the record)
- **Evidence:** `src/lib/plugins.ts` evaluates extension modules via
  blob-URL `import()` in the app origin with access to everything the
  app can do, including same-origin `fetch('/api/account')` (the
  session cookie is HttpOnly but `fetch` sends it automatically). A
  malicious extension index could therefore read the synced library.
  The file header documents this ("Modules are TRUSTED code: they
  execute with the app's privileges. Only install indexes you
  control.").
- **Fix (long-term):** run plugin modules in a sandboxed worker/iframe
  with a capability-limited host API. No action needed if the trust
  model stands.

#### 18. Retained original backup is one IndexedDB value up to the 128 MB file limit — past Chrome's ~127 MB per-value cap
- **Severity:** nit
- **Evidence:** `inspectTachibkFile` (`src/backup/tachibk.ts`) allows
  files up to 128 MB, and the final transaction stores the whole file
  as a single `archives` value. A backup between ~127 MB and 128 MB
  would restore all titles and then fail at the archive put, surfacing
  as "Restore failed" with the restore actually complete. (The user's
  real backup is 1.6 MB — no practical impact today.)
- **Fix:** lower the file limit to ~120 MB.

#### 19. Restore unconditionally overwrites local manga metadata with backup values
- **Severity:** nit
- **Evidence:** `restoreTachibk` puts `{ ...previous, key, manga, … }`
  — title/author/description/genres always come from the backup, even
  when the local copy was refreshed from the source more recently.
  (Chapter state and history correctly keep the newer side.)
- **Fix:** keep the local `manga` object when `previous.updatedAt` is
  newer than the backup's data, or compare per-field.

---

## Areas verified clean (no finding)

- **Sync edge cases:** offline open (cached user, local-first library,
  downloads work); mid-sync drop (idempotent re-push, ack only after
  success, mid-flight clock/device guard); session expiry — sessions
  have no expiry by design (server `expires_at` is 0, cookie 400 days,
  renewed on use); a dead/invalid token makes `status` return no user
  → clean signed-out state, and a 401 mid-cycle becomes `SessionError`
  → re-verification on next foreground/`online`; account switching
  pauses downloads, waits idle (30 s cap), swaps profiles atomically in
  one transaction, and restores the pause state.
- **Download queue mechanics:** oldest-first within title, title order
  by first-queued; pause/resume/cancel per job and global; interrupted
  jobs reset to queued on pump start; partial pages reused via the
  `X-Mihon-Page` identity hash; removal markers block late completion
  and resume interrupted cleanup on reopen (`resumeLibraryFileCleanup`
  via `reconcileDownloads` at boot).
- **Reader mechanics:** webtoon chaining appends under a labeled
  divider with a retryable error state; offset resume with a 7 s
  restore timeout; progress flush is write-chained, throttled to
  350 ms, forced on load/heartbeat/pagehide/unmount; read flag is
  sticky in `saveReadingProgress` (never un-set by scrolling back).
- **Extensions (read-only review):** install evaluates before
  persisting; bad modules never stored; boot skips broken plugins and
  records errors; Suwayomi catalog pagination, auth, and binding
  revalidation are sound; no per-site scraper work was done or is
  proposed here.
- **iOS Safari quirks:** safe-area insets are applied throughout
  (screens, topbar, tabbar, reader chrome, FAB, sheets, toasts);
  `100dvh` with `100vh` fallback; `viewport-fit=cover`;
  `navigator.storage.persist()` requested at boot and on download;
  profile snapshots chunked past the ~127 MB per-value limit; service
  worker uses prompt updates with `cleanupOutdatedCaches` and no
  runtime caching of covers (iOS-safe); PWA update prompt is
  dismissible and re-checks on `online`.

## Not checked (and why)

- **Physical iPhone behavior** (heat under load, background suspension,
  storage eviction, install/update prompt UX): no device access in this
  environment; code review only.
- **The `browserBackend` VPS test failure:** pre-existing, needs the
  live VPS browser service; live-bot/VPS work was out of scope.
- **Playwright e2e suite:** not run — the task specified the unit suite
  (`npm test`); e2e needs browsers and local servers.
- **Live reachability of built-in sources** (Asura/Mangakakalot) and
  **live Suwayomi server behavior:** code review only; no live checks
  run.
- **The parallel fast-scroller work:** not in the tree at inspection
  time (only `STATE.md` changed); it could not be reviewed or
  regression-tested here.
