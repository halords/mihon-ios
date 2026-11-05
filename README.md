# Mihon PWA

A local-first, installable PWA manga reader for iPhone, modelled on
[Mihon](https://github.com/mihonapp/mihon) (Android). No account, no server:
your library, categories, reading progress, history, settings and downloaded
chapters live **only on your device** (IndexedDB + localStorage + Cache
Storage), and the installed app opens and works fully offline.

## Sources

- **MangaDex** (`src/sources/mangadexSource.ts`) — a real adapter against the
  official public MangaDex API (`https://api.mangadex.org`). Popular, latest
  updates, search, details, chapter feed (English), and pages via the
  at-home server. Content ratings default to safe + suggestive.
- **Sample source** (`src/sources/sampleSource.ts`) — bundled offline demo
  content with locally generated SVG pages. Works with no network at all and
  demonstrates the "new chapter appears on refresh" Updates flow.

No other sources are bundled. In particular there is **no MangaHub adapter
and no scraping** of any manga site.

## Run it

```bash
npm install
npm run dev      # local development
npm run build    # production build (tsc + vite + service worker)
npm run preview  # serve the production build
```

## Install on iPhone

1. Deploy or serve the production build over HTTPS (e.g. Vercel).
2. Open the URL in **Safari** on the iPhone.
3. Tap **Share → Add to Home Screen**.
4. Launch "Mihon" from the home screen — it runs standalone, full-screen,
   and offline. The service worker precaches the whole app shell.

Tip: in **More → Settings → Storage**, request persistent storage and check
the on-device usage readout.

## Features

- **Library** with categories (Default, Reading, Completed, On Hold,
  Dropped — plus any categories created by a backup import), grid/list
  toggle, unread badges, per-item menu (move category, mark all read,
  remove).
- **Browse** across sources with search; manga details with chapter list,
  read/download state, Start/Continue.
- **Reader**: vertical (webtoon) and paged modes, tap zones, preloading,
  progress bar, resume where you left off, chapter-end prev/next.
- **Downloads** (headline feature): per-chapter download into Cache Storage
  with live progress; downloaded chapters are read **100% from cache** —
  they work end-to-end in airplane mode. Delete per chapter or per manga;
  "Delete all downloads" lives in Settings.
- **Updates**: refresh checks your library sources for new chapters.
- **History**: recently read chapters with one-tap resume.
- **Settings**: reader defaults, dark/light theme, optional CORS proxy,
  storage usage + persistence, and backup/restore.

## Backup & device-to-device transfer

There is no account sync — backups are the safety net (More → Settings →
**Backup & restore**, kept prominent for that reason):

- **Export / import JSON** — this app's own full backup format (library,
  chapters, read state, history, download metadata).
- **Import Mihon Android backup (`.tachibk`)** — imports categories,
  library manga, per-chapter read state + last page read, and reading
  history from a Mihon/Tachiyomi backup file (gzip-compressed protobuf;
  parser in `src/backup/`).
  - Entries from **MangaDex** (matched by Mihon source id
    `2499283573021220255` or by source name) become fully readable through
    the built-in adapter.
  - Entries from any other source import completely as library entries —
    metadata, categories, chapters and progress — badged **"source not
    available in PWA yet"**. Their reading content arrives when a web
    adapter for that source exists.
  - A manga with several Mihon categories is filed under its first one
    (the PWA uses one category per entry).
- Export of `.tachibk` is not supported; JSON is the export format.

## Writing a new source adapter

Implement the `Source` interface in `src/sources/Source.ts`:

```ts
interface Source {
  id: string;
  name: string;
  getPopularManga(page: number): Promise<SManga[]>;
  getLatestUpdates(page: number): Promise<SManga[]>;
  searchManga(query: string, page: number): Promise<SManga[]>;
  getMangaDetails(id: string): Promise<SManga>;
  getChapterList(mangaId: string): Promise<SChapter[]>;
  getPageList(chapterId: string): Promise<MangaPage[]>;
}
```

Then register the adapter in `src/sources/index.ts`. Use
`fetchJson` from `src/lib/fetchJson.ts` for HTTP so the user's optional
proxy setting is honoured. Manga/chapter ids are source-local strings;
the `mangaKey`/`chapterKey` helpers build the storage keys.

## CORS and the proxy setting

Browser `fetch` is subject to CORS. The MangaDex API allows cross-origin
GET requests, so it works directly. Sources whose APIs do not send CORS
headers need a proxy: set **PROXY_BASE** in Settings (e.g.
`https://your-proxy.example/`) and `fetchJson` will prefix request URLs
with it (`{proxyBase}/{original url}`). Leave it empty for direct requests.

## Privacy / storage notes

- Everything is stored on-device; the only network traffic is to source
  APIs (and your optional proxy).
- The app requests persistent storage on launch (best effort) and from
  Settings, so the browser is less likely to evict your library/downloads.
- Downloaded pages are stored in the `mihon-pages-v1` cache; library data
  lives in the `mihon-pwa` IndexedDB database.
