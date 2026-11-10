# Follow-up fixes spec — guest snapshot chunking, Library refresh feedback, DB "closing" recovery

Status: **DRAFT 2026-11-10 (evening). Not built, not pushed.** Written from the
three defects the live acceptance run surfaced on 2026-11-10 while the
user's own sync was running. Build only on the user's word, and only
after his live pull has finished — nothing here touches the sync path
while it is in flight.

## Where the three defects came from

During the sync-revision acceptance test (throwaway account, the user's
real backup) the main agent reported, 2026-11-10 ~20:32 Manila:

1. Signing in or registering when a large *guest* library already exists
   on the device fails on desktop Chrome — the app snapshots the whole
   device library into a single stored value when linking an account,
   and at ~152 MB that exceeds Chrome's ~127 MB per-value limit. The
   user's phones dodged it (he logged in before the library got big /
   different limits there), but a guest-first user on desktop would hit it.
2. The Library refresh button on iOS PWA "doesn't do anything" — it is
   wired up, but gives zero visual feedback while it works.
3. After the failed registration in that oversized profile, the database
   connection got stuck "closing" and the in-app Retry couldn't recover
   it — only a full reload did. The same transient glitch appeared once
   after the big restore test earlier the same day.

## Fix 1 — Chunk the guest-profile snapshot (the real bug)

### Diagnosis, verified in code

`activateAccountProfile` (`src/lib/account.ts:60-84`) snapshots the
entire current profile into **one** `syncProfiles` record before
switching accounts:

- `stores[store] = await tx.objectStore(store).getAll()` for every store
  in `PROFILE_STORES` (manga, chapterMeta, chapterState, library,
  history, categories, downloads, …), plus `libraryPreferences`,
  `records` (all `syncRecords`), cursor, clock and lastSync;
- then a single `tx.objectStore('syncProfiles').put(profile)` — one
  IndexedDB value holding the whole device library.

At the user's library size that single value is ~152 MB, past Chrome's
~127 MB per-value limit, so the put fails and sign-in / registration
with a large guest library fails with it. The adoption side
(`addDeviceLibrary`, `src/lib/account.ts:242-270`) reads that same single
record back (`db.get('syncProfiles', 'guest')`) and replays it via
`importData`, so the single-value assumption is load-bearing on both
ends. The `syncProfiles` store itself is defined in
`src/lib/db.ts:143,226` (`{ key: string; value: DeviceProfile }`,
keyPath `key`).

### Change

- Split the snapshot into **bounded chunks**: one `syncProfiles` record
  per store (key e.g. `guest:<store>`), or fixed-size chunk records
  with a small manifest record (`guest:manifest`) listing chunk keys,
  counts and a checksum — whichever the implementer finds cleaner.
  No single stored value may exceed a conservative budget (e.g. 16 MB;
  chapterMeta/chapterState are the big stores and must be split
  further if one store alone exceeds it).
- `activateAccountProfile` writes the chunks; `addDeviceLibrary` and
  the profile-restore path reassemble them in store order. Keep the
  existing semantics: snapshot-then-switch is still atomic from the
  caller's point of view (all chunks written before the switch commits;
  a partial snapshot is ignored / cleaned up on the next attempt).
- Keep the old single-record shape readable for one release if cheap
  (a `guest` key written by an old client should still adopt); do not
  change the sync wire format or conflict rules — this is local storage
  only.
- The fix must not change the happy path the user already uses: his
  phones logged in first, so their profiles were never snapshotted at
  this size.

### Acceptance

- Desktop Chrome, fresh profile: restore the user's real backup as
  guest, then register a throwaway account. Registration succeeds, the
  full library adopts (146 titles, 60,192 chapters, 20,007 history),
  and a subsequent pull-down on a second client returns the same
  counts exactly.
- Same flow via sign-in (not just register) on a second throwaway
  account.
- Regression: the existing small-library guest → account flow still
  works unchanged, and a failed snapshot attempt leaves no partial
  `guest:*` records behind.

## Fix 2 — Library refresh button must answer back

### Diagnosis, verified in code

`src/pages/LibraryPage.tsx:130` — the header refresh button calls
`reload()` from `useLibraryData` (lines 65-82), which sets `loading`
true and rebuilds the snapshot. But line 140 renders the spinner only
as `{loading && !data ? <div className="spinner" …/> : …}` — when the
library already has data, a tap produces **zero visual response** while
the reload runs, and the reload itself is queued behind any sync-pull
write batches, so it can take seconds of silence. If no new titles
landed since the snapshot, the refreshed view is identical — "nothing
happened" is literally what it renders.

### Change

- While `loading` is true, spin the refresh icon (CSS spin class on the
  button/icon + `aria-busy="true"` on the button) so every tap visibly
  answers, whether or not the library already has data. Keep the
  snapshot semantics from the sync revision: the view stays static
  until the reload completes, and no auto-reload is added.
- Optional, same change: if the reload completes with zero changes,
  that is fine — the spin stopping is itself the answer. Do not add a
  toast or a fake "up to date" banner unless the user asks.

### Acceptance

- With a populated library, tap refresh: the icon spins until the
  reload finishes, then stops. No spinner-on-empty behaviour regresses
  (empty library still shows the full-page spinner).
- After the user's iPhone pull finishes, a refresh visibly snaps in
  newly landed titles at once.

## Fix 3 — Fail cleanly when the database connection gets stuck "closing"

### Diagnosis, verified in code

Two sightings of the same transient, both 2026-11-10:

- After the big restore test, the Library tab briefly showed
  "database connection is closing"; a reload fixed it.
- After the failed registration in the oversized guest profile, the
  connection got stuck "closing" and the in-app Retry couldn't recover
  it — only a full reload did.

The relevant machinery is in `src/lib/db.ts`: the `blocking()` handler
(line ~236) closes the database and clears the cached
`databasePromise` on a version-change event, and the Library error UI
(`src/pages/LibraryPage.tsx:140`) offers a Retry that just calls
`reload()` — which re-reads through the same cached connection. If the
cached promise resolves to a closing/closed connection, every retry
fails the same way and only a full page reload (fresh `databasePromise`)
recovers.

### Change

- Reproduce the stuck state in the test browser first (force a
  version-change / blocked event, or the failed-registration path from
  Fix 1), and confirm the Retry loop fails before fixing.
- Make the failure clean: on any IDB open / transaction failure that
  reports a closing/closed connection, drop the cached connection
  promise and re-open before retrying, so the in-app Retry actually
  re-initialises instead of re-using the dead connection. Surface a
  real error message (not a bare "closing" string) with a Retry that
  works.
- Do not change the `blocking()` close itself — closing on
  version-change is correct; the defect is only that nothing recovers
  from it short of a reload.

### Acceptance

- In the test browser, force the stuck-"closing" state, then tap the
  in-app Retry: the library loads without a full page reload.
- Restore-then-open-Library no longer shows the transient "database
  connection is closing" error; if it ever does, Retry recovers it.

## Guardrails (same as the sync revision)

- Build only on the user's word; nothing ships while his live pull is
  in flight.
- Wire format and conflict rules do not change. Old clients keep
  working against the new server and vice versa.
- Test-first: each fix lands with a failing-before / passing-after
  test, and the acceptance runs above use the throwaway account + the
  user's real backup, as the sync revision did.
- Suggested order: Fix 1 first (real data-path bug, blocks a whole
  user class), Fix 3 second (recovery robustness, same area), Fix 2
  last (small UX polish, minutes of work).
