# Sync revision spec — bulk-transfer throughput

Status: **IMPLEMENTED locally 2026-11-10 (commits held, not pushed).** Deploy waits for the user to confirm his live sync drained and approve the push; the rollout protocol below (step 4 live verification) runs after deploy.
Written 2026-11-10 (evening). Trigger: the user's first full-library sync
(~117k pending records from a 310-title / 60,192-chapter backup restore)
took on the order of an hour. The user directed: no changes while that
sync is running; implement from this spec afterwards.

## The problem, measured

The records are small and the database is fast. The pipeline around them
is sized for incremental sync (a few records per reading session), not
for a six-figure initial migration:

| Stage | Current behaviour | Cost at ~141k records |
| --- | --- | --- |
| Client push batching (`src/lib/account.ts`, `cycle()`) | ≤256 records **and** ≤1 MB per request, with size over-estimated 3× (`JSON.stringify(record).length * 3`) → effective payload ≈341 KB | **~550–1,000 sequential requests** |
| Client acknowledge (`acknowledgeChanges`) | One transaction per batch, but a **per-record awaited get+put** inside it (256 awaited round trips per batch) | ~141k awaited IDB round trips |
| Server body cap (`server/account.ts`, `body()`) | Hard **2 MB** limit → 413 above it | Caps any client-side batch increase |
| Server push (`server/accountDatabase.ts`, `pushChanges`) | Already bulk-shaped: all statements in **one `client.batch(..., 'write')`** (2 statements per change: clock bump + upsert) | Not the bottleneck — reuse as-is |
| Server pull page (`pullChanges`) | ≤1,000 candidate rows, then a ~1 MB cumulative byte budget per page | **~141–250 sequential page requests** |
| Client pull apply (`applyRemoteChanges`) | One transaction per page, but **per-change awaited** get/put (≈3–4 awaited ops per change) | ~500k awaited IDB round trips |

Platform ceilings for reference (verified 2026-11-10): Vercel function
request/response body **4.5 MB on every plan**; Hobby function duration
300 s; Turso free plan 10M rows written/mo, 500M read/mo, 5 GB storage —
a 141k-record sync uses ~1.4% of monthly writes. Neither platform is the
constraint; the batching constants are.

## Design principles (user, 2026-11-10)

- Nothing dynamic for its own sake: transfers happen in deliberate,
  bounded cycles; the UI updates when an operation completes, not per
  record.
- Never endanger an in-flight sync: this revision ships only when the
  live pending count is 0, and wire format does not change (below), so a
  client that somehow runs old code against the new server (or the
  reverse, briefly, via service-worker lag) still syncs correctly —
  small batches remain valid forever.

## Changes

### 1. Client push — bigger, byte-measured batches (`src/lib/account.ts`)

- Replace the 256-record / 1 MB-with-3×-estimate rule with:
  - **Byte budget 3.5 MB**, measured exactly with `TextEncoder` on the
    serialized request body (no ×3 fudge), and
  - **Record cap 4,000** per batch, whichever comes first.
- Keep the loop **sequential** (batch → ack → next). With ~30× larger
  batches, a 141k backlog is ~12–35 requests; ordering and error
  semantics stay exactly as they are today.
- Expected payload: the user's real backlog is ~40 MB of JSON total →
  ~12 requests at the new budget.

### 2. Client acknowledge — stop the per-record await storm

- Rewrite `acknowledgeChanges` to queue the puts through the native
  store (the `syncNativeStore` pattern already used by the backup
  restore) and complete on `tx.done`, instead of awaiting a get+put per
  record.
- Preserve the existing guard semantics: a record is only marked
  not-pending if its current clock **and** deviceId still match what was
  sent (a record edited mid-flight must stay pending). Implement the
  check from a single bulk read of the sent ids inside the same
  transaction, not one awaited get per record.

### 3. Server body cap — 2 MB → 4 MB (`server/account.ts`)

- Raise both enforcement points in `body()` from `2 * 1024 * 1024` to
  `4 * 1024 * 1024`, keeping 0.5 MB headroom under Vercel's 4.5 MB hard
  cap. Client budget (3.5 MB) stays below the server cap, which stays
  below the platform cap.

### 4. Server push — verify the batch statement ceiling, sub-batch if needed

- `pushChanges` already sends one libSQL batch per request. At 4,000
  changes that is ~8,000 statements in a single batch call. **Measure
  first** against the real Turso database with a synthetic 4,000-change
  push: if the batch errors or is unreasonably slow, chunk the
  statements inside `pushChanges` into sequential batch calls of
  ≤1,000 changes each — still one client HTTP request, still atomic
  per chunk, and the upsert/clock logic is idempotent across chunks.
- Do not change the SQL, the conflict rule
  (`client_clock`, then `device_id`), or the clock table.

### 5. Pull — larger pages, native-queue apply

- `pullChanges`: raise the candidate `LIMIT` from 1,000 to **5,000**
  and the page byte budget from ~1 MB to **3.5 MB**, keeping the
  `position = 1` escape so a single oversized record can never wedge
  pagination.
- `applyRemoteChanges`: mirror the restore pattern — queue store puts
  and syncRecord puts through native stores within the page transaction
  and complete on `tx.done`; keep the per-change reads that are
  semantically required (local-newer check via `syncRecords`, the
  `chapterState.downloaded` preservation read, library-removal
  bookkeeping) but source them from bulk reads/maps per page rather
  than one awaited get per change where a map suffices.
- Keep the cursor/hasMore contract identical.

### 6. Progress reporting

- During a push cycle, refresh the published pending count **after each
  batch ack** (today `summary()` runs at cycle end and on some events).
  With large batches the counter should visibly fall in big steps; the
  user watches this number.

## Explicitly out of scope

- No change to the sync record format, the conflict rule, the clock
  scheme, the endpoints, or the auth/session flow.
- No parallel/concurrent push requests (Turso is single-writer; the win
  is batch size, not concurrency).
- No change to what gets journaled (every SYNC_STORES write still
  journals exactly one sync record).
- Library session-cache is a separate change (Phase 0, below).

## Phase 0 (already implemented, awaiting deploy)

`src/pages/LibraryPage.tsx` — session snapshot cache, built 2026-11-10:
the library view assembles once per app load, tab switches render it
instantly, the `mihon:data-changed` auto-reload subscription is removed,
and the view updates only after in-page actions or the new header
refresh button. Typecheck clean; unit suite at baseline. Committed
locally only — **not pushed**, so no service-worker update reaches the
user's phone mid-sync. Deploy it together with, or after, this sync
revision.

## Rollout protocol

1. **Gate:** user confirms the live sync shows pending = 0. Nothing in
  this spec is implemented or deployed before that.
2. Implement changes 1–6 in one pass; run the full unit suite
  (baseline: 101/102, the one failure being the pre-existing
  VPS-dependent `browserBackend` test).
3. New tests:
   - push accepts a 4,000-change batch and a ~3.5 MB body; rejects
     >4 MB with the existing 413;
   - pull of >5,000 records paginates with a correct cursor chain and
     no duplicates/gaps;
   - ack leaves a record pending when its clock changed mid-flight
     (guard preserved);
   - apply of a 5,000-change page produces identical store contents to
     the current per-change path (fixture diff).
4. Live verification on a **throwaway account**: restore the user's
   real backup fixture (310 titles / 60,192 chapters / 20,007 history)
   in a test profile, sync up, then pull on a second profile and diff
   store counts. **Acceptance: full initial sync < 3 minutes** in the
   sandbox (expected ~1 minute), counts exact on both sides.
5. One-shot push of the whole change-set (client + server + tests +
   STATE.md) in a single commit; Vercel deploys API and PWA together,
   so there is no mixed-version window on the server side. A phone
   still running the old PWA against the new server keeps working
   (small batches remain valid).
6. Update STATE.md with the measured before/after timings.

## Risks

- **libSQL batch size:** unverified statement ceiling — change 4 is
  explicitly measure-first with a sub-batching fallback.
- **Phone memory:** building a 3.5 MB request body is fine; do not
  raise the budget further without re-measuring on the user's Redmi
  class of device.
- **Ack semantics:** the mid-flight-edit guard is the one place a
  careless rewrite could silently drop a pending change — covered by a
  dedicated test (Rollout 3).
- **Pull apply maps:** chapterState's local `downloaded` flag must
  survive a pull exactly as today — the fixture-diff test (Rollout 3)
  exists to catch a regression here.
