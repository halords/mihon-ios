# Mihon PWA for iOS

An installable manga reader inspired by [Mihon Android](https://github.com/mihonapp/mihon). Import your Mihon library, retain its reading state, connect its Android sources through Suwayomi, and download chapters onto your iPhone for offline reading.

The app stores its library and reading data on the device. MangaDex is built in; [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) runs other compatible Android extensions on a computer or server. This project is independent of Mihon.

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

Open `http://localhost:4173`. `npm start` reads `.env` if present. Copy `.env.example` to `.env` to configure `SUWAYOMI_URL` for the bundled connection. `npm run preview` also includes the proxies.

For the PWA, Suwayomi, and optional trusted HTTPS setup together, follow [docs/SUWAYOMI.md](docs/SUWAYOMI.md). There is also an offline setup guide at `/help/suwayomi.html`, linked from Connections.

## Migrate from Mihon

1. Export a `.tachibk` backup from Mihon and move it to your iPhone’s Files app.
2. Open **More → Backup & restore → Choose backup**. Review the counts and sources, then restore. Restoration merges with your library and preserves newer local reading progress.
3. For Android sources, start Suwayomi and connect in **Connections**. Open **Browse → Extensions**, add the stores retained from your Mihon backup, and install the matching extensions. You can also use Suwayomi's WebUI.
4. Use **Copy to server** beside the retained Mihon backup. This gives Suwayomi the original source IDs and manga/chapter URLs. If your hosting platform limits uploads, restore the original file in Suwayomi’s WebUI instead.
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

MangaDex entries from compatible Mihon source IDs or names use the built-in adapter. Other imported source IDs remain exact so a matching Suwayomi extension or web adapter can resolve them. A sample source and web-extension demo are included for trying the reader without external services.

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

- **Node/Docker:** the production server serves `dist/`, proxies official MangaDex hosts, and proxies a pinned `SUWAYOMI_URL` under `/api/suwayomi/`.
- **Vercel:** `vercel.json` routes nested Suwayomi requests to the included function. Set `SUWAYOMI_URL` in the deployment environment. Function upload/response limits may require direct HTTPS Suwayomi or the Node server for large backups and image pages.
- **Static hosting:** the app shell works, but source networking needs a separately hosted compatible proxy or a direct HTTPS server with CORS support. MangaDex uses `/api/proxy`, so a static-only host must provide that route.

The bundled proxy is limited to official MangaDex hosts and the configured Suwayomi server. Other web adapters can use a CORS-enabled API or the custom proxy setting, including `https://proxy.example/?url={url}` templates. See [PLUGIN.md](PLUGIN.md) for the web extension contract. Android APKs run in Suwayomi; they cannot execute inside an iOS browser.

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
