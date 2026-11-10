# Built-in sources from the Mihon backup

Open **Browse → Sources** and choose a source. **Browse → Extensions → Built-in sources** lists the included adapters. They are available immediately, with no APK installation, Suwayomi connection, or backup upload to another server.

The app includes exactly the source identities used by the supplied `.tachibk`. The two Manhwa18.cc IDs remain separate for compatibility. MangaDex imports map to the existing MangaDex adapter.

| Source | Mihon source ID | Live check on 2026-11-10 |
| --- | --- | --- |
| MangaHub | `4758858684982406533` | Website and API deny app access with HTTP 403 after adding Mihon's access-key refresh flow. A real Chromium session reaches the verification page. The current extension lists only `mangahub.io`; no working alternate official mirror was identified. |
| Mangakakalot | `2528986671771677900` | Browse, exact title search, details, 3,877 chapters, page list and image bytes verified on the official `www.mangakakalove.com` mirror. The previous `www.kakamanga.com` mirror blocks search. |
| Manhwa18.cc | `993336618407081332` | Website certificate chain fails verification in this environment. Adapter tested with synthetic YiiMadara pages. |
| Manhwa18.cc (legacy) | `4841602236575491202` | Uses the same website and parser; original ID retained. |
| MangaDex | `2499283573021220255` | Existing adapter, mapped to PWA ID `mangadex`; original Android ID retained on export. |
| Asura Scans | `6247824327199706550` | Browse, details, 348 chapters, page list and image bytes verified. Astro data and public image tile reconstruction supported. Subscription chapters are marked external. |
| MangaLife | `7798162483793432927` | Corrected to its original extension domain, `manga4life.com`, which currently fails DNS resolution from the verification host. Original reader parser tested with synthetic data. |
| MangaFox | `6484561431658238800` | Browse, details, 132 chapters, mobile page list and image bytes verified. |
| Kissmanga.in | `3112384885023225761` | Website returns an HTTP 403 access challenge. Madara catalog/details/chapter format supported; access failures are shown in the app. |

These checks are samples, not a guarantee that every title or release remains available. Blocked sites display a source error and an **Open source website** link. The adapter does not solve access challenges, bypass subscriptions, disable certificate verification, or migrate a title to another website automatically.

All backup source rows use bundled extension logos in Browse, Extensions, backup preview, Connections, title details and migration. They are cached with the app shell. Unknown sources use a name monogram; web adapters can supply an `iconUrl` for Browse.

MangaHub now saves the returned public `mhub_access` key, refreshes it on the current title/chapter page with `reloadKey=1`, reads cookies from original-page redirects, and serializes concurrent key refreshes. GraphQL requests use the expected origin and access header. Retry attempts are bounded, and continued site denial remains visible.

An optional [browser backend](BROWSER_BACKEND.md) provides user-operated website verification and browser-session requests within the PWA. It requires a browser-capable host. It cannot turn Safari into Mihon's shared Android WebView or make an unavailable website respond. No backend is required for sources whose ordinary HTTP requests work.

## Hosting

Built-in source logic runs in TypeScript in the PWA. Safari cannot fetch many websites directly because of cross-origin restrictions, so metadata and images use the application's narrowly scoped HTTP routes. Users do not need to run a separate Suwayomi server or keep their own PC on when the PWA is deployed with its functions.

For Node hosting, run `npm run build` and `npm start`. Vite dev/preview and the repository's Vercel functions include the same `/api/source` route; MangaDex uses `/api/proxy`. A static-only deployment must also provide these routes. Built-in sources do not require `SUWAYOMI_URL`.

## Existing library and Android export

Restore the `.tachibk`, open a title and refresh chapters. The adapters use the backup's source IDs and URLs. Where a website changed its URL format, old chapter IDs are reused only for one unique URL or chapter-number match within that exact title. Duplicate releases are not merged by number. Reading progress, bookmarks and cached downloads continue to use the retained IDs, while refreshed URLs are used for future requests and `.tachibk` export.

Mangakakalot's current Android extension derives old opaque Manganato IDs from the saved title. The PWA follows that convention and additionally verifies the exact normalized title before loading chapters. A mismatch requires **Migrate source**.

Migration defaults to Asura Scans (Mangakakalot when the original is already Asura), and searches the selected replacement source automatically. Changing sources clears the old results/review, and late responses from previous searches cannot replace the current selection. MangaBox search follows the website's lowercase, accent and punctuation alias rules and reads titles from their title links. Asura's subscription chapters open their actual source page.

Chapter rows pair a purple unread dot or a read checkmark with the upload date on one line. Read chapters have muted titles; status labels remain available to screen readers. Long-press a chapter, then another, to select the inclusive range in the displayed order. Tap individual chapters to adjust the selection, then use the floating Read/Unread controls. Fully read library entries show a Read badge and less saturated cover artwork. Migration uses a small source logo beside each title.

Downloaded chapters remain readable without the website or a server connection. Export their images separately as CBZ when returning to Android. The current-state `.tachibk` export continues to use the original numeric source IDs.

## References and validation

Adapters were ported from [Keiyoushi extension sources](https://github.com/keiyoushi/extensions-source/tree/1b7089818edf1e36bf71256369e4c6f36bbd9158): MangaHub, MangaBox, YiiMadara/Madara, Asura Scans, and MangaFox. See [third-party notices](../THIRD_PARTY_NOTICES.md). MangaLife retains the original public reader's JSON literal format; remote JavaScript is never evaluated.

Unit checks cover identities, HTTPS host/redirect restrictions, read-only proxy requests, source errors, chapter key preservation, ambiguous releases, and MangaHub page decoding. Mobile Chromium and WebKit fixtures cover built-in browsing, reader images, Asura tile reconstruction and offline downloads. Physical iPhone behavior and a deployed production host remain unverified.
