# Mihon PWA for iOS

An installable manga reader inspired by [Mihon Android](https://github.com/mihonapp/mihon). Import your Mihon library, retain its reading state, browse built-in sources, and download chapters onto your iPhone for offline reading.

The app stores its library and reading data on the device. The supplied backup's sources have integrated web adapters: MangaHub, Mangakakalot, Manhwa18.cc (including its legacy ID), MangaDex, Asura Scans, MangaLife, MangaFox, and Kissmanga.in. These adapters use the app's included HTTP functions and require no Suwayomi setup. Website availability varies; see [source status and setup](docs/SOURCES.md). [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) remains available for compatible Android APK extensions. This project is independent of Mihon.

## Start locally

Use Node **22.18 or newer**; the Docker image uses Node 24.

```sh
npm ci
npm run dev
```

For the production app and its API proxies:

```sh
npm run build
npm start
```

Open `http://localhost:4173`. Built-in sources need no `.env` or `SUWAYOMI_URL`. `npm start` reads `.env` if present; use it to configure the optional Suwayomi connection. `npm run preview` also includes the proxies.

For the PWA, Suwayomi, and optional trusted HTTPS setup together, follow [docs/SUWAYOMI.md](docs/SUWAYOMI.md). There is also an offline setup guide at `/help/suwayomi.html`, linked from Connections.

For sources that require website verification, an optional [browser backend](docs/BROWSER_BACKEND.md) lets you operate the source's server-side browser from the PWA and reuse its session. This requires a browser-capable host; it is not activated by default and cannot create a shared Safari website session on its own. The existing HTTP adapters, downloads and migration continue to work independently.

## Migrate from Mihon

1. Export a `.tachibk` backup from Mihon and move it to your iPhone’s Files app.
2. Open **More → Backup & restore → Choose backup**. Review the counts and sources, then restore. Restoration merges with your library and preserves newer local reading progress.
3. Open **Browse → Sources** and choose a built-in source. Imported source IDs and chapter keys match the adapters; no extension installation or **Copy to server** is needed for built-in sources.
4. For other Android extensions, optionally connect Suwayomi in **Connections**, install their matching extensions under **Browse → Extensions → Mihon extensions**, and use **Copy to server** beside the retained backup.
5. Open a title and download chapters. Completed chapters can be read with both the network and Suwayomi unavailable.

The repository's `app.mihon_2026-11-07_15-00.tachibk` is an empty placeholder. The separate original backup supplied from Downloads was parsed successfully: 310 manga records, 146 library titles, 60,192 chapters and 19,965 history entries. Personal backup files and generated inspection artifacts are excluded from Git.

### What a Mihon restore retains

| Data | Behavior |
| --- | --- |
| Manga and sources | Metadata, exact signed 64-bit source IDs, original URLs, favorite state, added dates, flags, and notes are retained. Unavailable sources still import. |
| Categories | Names, order, flags, and every membership are retained. A title can belong to several categories. |
| Chapters | Metadata, read/unread state, last page, bookmarks, scanlators, source order, dates, and memos are retained. |
| History | Reading dates and duration are retained. The PWA records new progress and history together. |
| Tracking | Original tracking IDs, scores, status, and progress are retained and viewable. Tracker login and live tracker synchronization are not implemented. |
| Preferences | Matching reader and library sort preferences can be applied. Android preferences, source preferences, and extension repository metadata are retained even when there is no web equivalent. |
| Original file | The original compressed bytes are retained by SHA-256 and can be downloaded unchanged. This preserves future and Android-specific fields. |

A `.tachibk` does **not** contain downloaded chapter images or the Android extension APKs. Install matching extensions in Suwayomi, then download pages or import existing chapter files.

### Move existing Android downloads

Put each chapter’s numbered image files in its own ZIP/CBZ archive. Under **Backup & restore → Import offline chapters**, select the imported title as the destination and choose its chapter files. Exact chapter names are recommended; ambiguous chapter-number matches are rejected so progress is not attached to the wrong chapter. You can also create local titles from CBZ files without a source connection.

## Reading and library features

- Library search, categories, multiple memberships, grid/list views, a visible sort control, unread and download badges, and batch actions. Last read defaults to newest first; restoring matching preferences applies Mihon's saved sort direction. Alphabetical, date added, unread count, total chapters, last update, latest chapter, chapter fetch date and stable random ordering are also available.
- Webtoon reading with optional continuous chapters, LTR/RTL paged reading, fit controls, zoom, swipe/keyboard navigation, bookmarks, page seeking, and resume offsets.
- A persistent download queue with progress, pause, resume, cancel, retry, interrupted-download recovery, and a foreground screen wake lock where supported.
- Download management, CBZ export, storage usage, and persistent-storage requests.
- Browse Sources/Extensions/Titles sections, source search and language filtering, source-specific pagination, MangaDex language/data-saver settings, and installable web adapters. The Mihon extension catalog supports store management, language/status filtering, install, update and uninstall through Suwayomi. Stores from a restored backup can be added directly from the extension screen.
- Library updates that isolate individual source failures, saved update results, searchable reading history, and source migration that carries reading state.
- Dark/light themes, mobile safe areas, install icons, an offline app shell, and an explicit app-update prompt.

MangaDex entries from compatible Mihon source IDs or names use its built-in adapter. Other backup IDs remain exact. Chapter refreshes retain old keys when URLs or chapter numbers identify one unique release within the same title; ambiguous releases keep separate keys. A demo web extension is available for development but is not installed or listed in Browse by default.

## Install and read offline on iPhone

Serve the production app over **trusted HTTPS**. Open it in Safari, choose **Share → Add to Home Screen**, and launch the installed app. Import and read from that same installed app; Safari tabs and Home Screen installations can have separate storage.

Open the installed app online once so its service worker saves the app shell. Keep it visible while chapters download, and wait for them to appear under **Downloads → Downloaded**. Then turn on airplane mode and open a downloaded chapter. Cached pages load directly from the device without contacting a source or server.

iOS can suspend an app after it enters the background and can evict browser storage under pressure. The queue persists and resumes when you reopen it, but an iOS PWA cannot promise Android-style background downloads or permanent storage. Request persistent storage in Settings and keep your exports.

The reader materializes cached image URLs near the viewport and releases them as they move away to reduce memory use on long chapters. Download manifests are checked against actual cached pages; a restored metadata flag cannot falsely claim that pages are available offline.

## Back up this PWA

Use **Export PWA library (.json)** for metadata, reading state, settings, categories, web extension code, and original Mihon archives. Export downloaded chapter images separately as **CBZ** from Downloads. Restore the JSON, then attach the CBZ files to their existing titles to move both data and pages to another device.

Use **Export for Mihon Android (.tachibk)** to create a new compressed Mihon backup containing current library membership, progress, bookmarks, history, categories, notes, tracking records, compatible source IDs and retained Android preferences/stores. Install matching extensions on Android, then restore the file in Mihon. Chapters downloaded on iOS must be exported separately as CBZ. Browser-only source IDs cannot be represented in Mihon; the export explains which titles need source migration instead of silently omitting them.

JSON v1 backups remain readable. JSON v2 preserves the additional migration metadata. Included web extension code is only activated when you select that restore option. There is no account synchronization. The original `.tachibk` can also be exported unchanged; generated Android backups contain current supported data rather than an unchanged copy of the old file.

## Hosting and source networking

- **Node/Docker:** the production server serves `dist/`, MangaDex's `/api/proxy`, the built-in `/api/source` route, and the optional Suwayomi proxy.
- **Vercel:** the repository includes functions for both built-in source routes. No Suwayomi environment variable is needed for those adapters. Set `SUWAYOMI_URL` only for Android APK extension support. Function request/response limits still apply to large images and backups.
- **Static hosting:** the app shell works, but built-in source networking requires the included `/api/source` and `/api/proxy` routes. Deploy the Node server or the Vercel functions with the PWA.

The source proxy permits only each adapter's approved HTTPS website and image hosts, validates every redirect, and accepts small read-only requests on specific source API routes. Source scripts are parsed as data and never executed. Other web adapters can use a CORS-enabled API or a custom proxy setting; see [PLUGIN.md](PLUGIN.md). Android APKs run in Suwayomi; the integrated web adapters run in the PWA.

## Development checks

```sh
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
```

Unit tests cover protobuf preservation, transactional restoration, storage, source identity, networking cancellation, queue recovery, chapter file imports, downloads, and updates. Mobile Chromium/WebKit tests cover migration, categories, chapter imports, downloads, offline reloads, reader resume, final-page behavior, and navigation. [The optional live server check](docs/SUWAYOMI.md#live-server-contract-check) verifies backup restoration, original-URL resolution, page fetching, and offline caching against Suwayomi.

Physical iPhone installation and iOS storage eviction have not been verified. Full Android feature parity is not claimed; the core library, migration, reading, source management and offline download workflows are implemented. Android packages execute in Suwayomi rather than on the iPhone.

## References

- [Mihon schema reference](https://github.com/mihonapp/mihon/tree/524fa53043f2f5b2321ea13027e44f093ab4245c/app/src/main/java/eu/kanade/tachiyomi/data/backup/models)
- [Suwayomi Server](https://github.com/Suwayomi/Suwayomi-Server), with live API checks against **v2.4.2366**
- [Suwayomi Docker image](https://github.com/Suwayomi/Suwayomi-Server-docker)
