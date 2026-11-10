# Mihon PWA — Extension (source plugin) contract

Extensions let the PWA gain new sources **without rebuilding or redeploying
the app**, Mihon-style: the app is the shell, sources are installable
modules. This document is the complete contract for writing one.

## The two pieces

1. **Extension index** — a JSON file hosted anywhere reachable over HTTPS
   (a GitHub repo's raw URL works; it must be served with CORS `*` or from
   the app's own origin). Format:

```json
{
  "name": "My extension repo",
  "sources": [
    {
      "id": "4758858684982406533",
      "name": "Example Source",
      "version": "1.0.0",
      "lang": "en",
      "nsfw": false,
      "moduleUrl": "example-source.mjs"
    }
  ]
}
```

- `moduleUrl` may be relative — it resolves against the index URL.
- `version` is an opaque string. Bump it and the app offers an **Update**
  (reinstall) for that source.
- `id` is the source's identity everywhere in the app. **To make imported
  Mihon backup entries for a source become readable, `id` must be that
  source's Mihon numeric source ID as a string** (e.g. MangaHub is
  `"4758858684982406533"`, Mangakakalot is `"2528986671771677900"`).
  MangaDex is the one exception: built in as `"mangadex"`.

2. **Extension module** — one self-contained ES module file (`.mjs`):

- **No imports.** The module must not import anything; the app loads it
  standalone from storage. Everything it needs from the host is on
  `globalThis.MihonHost` (below).
- It must export `source` (named) or a default export: an object
  implementing the `Source` interface — identical to the built-in sources'
  contract (`src/sources/Source.ts`):

```ts
interface Source {
  id: string;          // must equal the index entry's id
  name: string;
  getPopularManga(page: number): Promise<SManga[]>;
  getLatestUpdates(page: number): Promise<SManga[]>;
  searchManga(query: string, page: number): Promise<SManga[]>;
  getMangaDetails(id: string): Promise<SManga>;
  getChapterList(mangaId: string): Promise<SChapter[]>;
  getPageList(chapterId: string, mangaId?: string, signal?: AbortSignal): Promise<MangaPage[]>; // { imageUrl }
}
```

`SManga` / `SChapter` shapes are in `src/sources/Source.ts`. `SChapter.number`
must be the real chapter number (migration and progress matching depend on
it). Mark chapters the source hosts elsewhere with `external: true` — the
app lists them but never tries to fetch their pages.

The exported object may be a class instance. Its prototype methods and
`this` state are preserved. Pass the optional `signal` to host fetch calls
inside `getPageList()` so pausing a download cancels source resolution too.

## Host API (`globalThis.MihonHost`, apiVersion 1)

Set by the app before your module is evaluated:

```ts
MihonHost.fetchJson<T>(url, init?): Promise<T>   // fetch + JSON, throws on !ok
MihonHost.fetchText(url, init?): Promise<string> // fetch + text, throws on !ok
MihonHost.proxiedUrl(url): string                // the app's URL rewriting hook
MihonHost.mangaKey(sourceId, mangaId): string
MihonHost.chapterKey(sourceId, mangaId, chapterId): string
```

## Networking / CORS — read this before writing fetch code

The module runs in the browser, so the browser's CORS rules apply in full:

- If the target host serves `Access-Control-Allow-Origin` for the app's
  origin (or `*`), direct `fetch` works.
- If it does not, use a custom CORS proxy in Settings. Query templates such
  as `https://proxy.example/?url={url}` are supported. The included
  `/api/proxy?url=…` only accepts official MangaDex HTTPS hosts, as defined
  in `server/proxy.ts`; it is not an unrestricted web proxy. Android
  extension requests use the separate, pinned Suwayomi connection.
- Page/cover **images** are displayed via `<img>`, which does not need
  CORS; but chapter **downloads** fetch image bytes, so downloads need
  CORS or the proxy route too.

## Install & lifecycle (what the app does)

1. The user adds the index URL under **More → Extensions** and taps
   **Install** on a source.
2. The app fetches the module code once, evaluates it, and validates it:
   exported `id` must equal the index `id`, all six methods must exist.
   A module that fails validation is **not stored**.
3. The code is stored on-device (IndexedDB) and registered as a source —
   immediately usable in Browse, search, details, reader, and downloads.
4. On every app start, installed modules are re-evaluated and registered
   before first render. A module that throws at load is skipped, shown as
   "failed to load" in Extensions, and never blocks the app.
5. **Remove** deletes the stored code and unregisters the source. Library
   entries for that source fall back to "source not available", exactly
   like un-imported backup entries; their progress data is kept.

## Trust model

Extension modules are **trusted code**: they execute with the app's full
privileges (same as Android Mihon extensions). There is no sandbox. Only
install indexes you control or fully trust; the app states this in the
Extensions screen.

## Working example

`public/extensions-demo/` in this repo: `index.json` + `demo-source.mjs`
(a network-free source with generated art). The app always lists this
built-in demo index, so the full install → browse → read → remove loop can
be tried with zero setup.
