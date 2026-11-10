# Run Mihon-compatible sources on iOS

The sources used by the supplied backup now have [built-in web adapters](SOURCES.md). Use **Browse → Sources** for those adapters; no Suwayomi connection or **Copy to server** is required. This guide covers the optional Android APK extension connection.

Suwayomi executes compatible Android source extensions on a computer or server. The PWA uses those sources to discover chapters and fetch image bytes, then keeps completed downloads on the iPhone. You can disconnect the server while reading downloaded chapters.

## Docker setup

Install Docker with Compose, then copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux, use `cp .env.example .env`. Edit `.env` and set `SUWAYOMI_PASSWORD` to a password you choose. The default username is `reader`.

```sh
docker compose up --build -d
```

Open **http://localhost:4567** on the Docker host and sign in. The included image is pinned to Suwayomi **v2.4.2366**. Its data and extensions live in the `suwayomi-data` volume. The PWA is served at **http://localhost:4173**, with the backend mounted at `/api/suwayomi`.

After connecting the PWA, open **Browse → Extensions → Mihon extensions**. Add an extension store using its HTTPS `index.pb` or `repo.json` URL, or use **Add store** beside the stores retained from your Mihon backup. Refresh the catalog, search by source or language, and install the extensions you need. Updates and uninstall are available on the same screen. Suwayomi's WebUI remains an alternative. `SUWAYOMI_EXTENSION_STORES` can also be set to a JSON array of store URLs in `.env` before starting the container.

In the PWA, open **Connections**, enter your chosen username/password under **Authentication**, and choose **Use bundled server**. Refresh sources after installing extensions. Credentials are held for that browser session and are excluded from library exports. The proxy preserves the server’s scoped session/CSRF cookies for authenticated backup uploads.

The Compose configuration binds the plain HTTP administration and app ports to the Docker host’s loopback interface. Open the WebUI on that computer, or use an SSH tunnel to administer a remote host. Use HTTPS for access from an iPhone.

### Trusted HTTPS with the included Caddy profile

Point a domain’s DNS records to your Docker host, make ports 80 and 443 reachable, and set this in `.env`:

```dotenv
MIHON_DOMAIN=reader.your-domain.com
```

Then start the HTTPS profile:

```sh
docker compose --profile https up --build -d
```

Caddy obtains a trusted certificate and serves the PWA at your domain, including its same-origin backend proxy. Open the URL in Safari and choose **Share → Add to Home Screen**. An untrusted local certificate or another computer’s plain HTTP LAN address is insufficient for reliable iOS PWA installation and offline service workers.

To stop the stack while keeping server data, run `docker compose --profile https down`. Keep the named data volumes when upgrading. Start the stack again after changing its image or environment configuration.

## Use an existing Suwayomi server

You can use the standalone releases from [Suwayomi Server](https://github.com/Suwayomi/Suwayomi-Server/releases) instead of Docker. The PWA connection has been checked against stable **v2.4.2366**; newer versions may change API or authentication behavior.

For the bundled proxy, put the server address in the PWA’s `.env`:

```dotenv
SUWAYOMI_URL=http://127.0.0.1:4567
PORT=4173
```

```sh
npm ci
npm run build
npm start
```

Serve that Node app through a trusted HTTPS reverse proxy. Choose **Use bundled server** in Connections. A private HTTP backend can remain behind the PWA’s HTTPS proxy.

Alternatively, enter Suwayomi’s own **HTTPS** address in Connections. It must permit the PWA’s origin through CORS. Basic authentication is supported by the connection screen; Suwayomi’s UI login modes are not integrated. Direct cross-origin Basic-auth backup uploads can fail the server’s cookie/CSRF checks on iOS. Use the same-origin bundled proxy or restore the retained backup in Suwayomi’s WebUI for that operation.

## Restore the original source URLs

1. In the PWA, import your actual nonempty `.tachibk` under **Backup & restore**. Review the source list and restore it.
2. In **Browse → Extensions**, add your saved stores and install matching extensions for the missing sources. **Browse → Sources** lists the IDs needed by your library. Match exact numeric source IDs; similarly named extensions or different languages can have different IDs.
3. Connect from the PWA and refresh sources.
4. Choose **Copy to server** beside the original archive in Connections. This explicitly merges that archive into your configured server. Local data is retained if the server restoration fails.
5. Open a title, refresh its chapter list, and download the chapters you want on the device.

The adapter resolves a manga using its exact source ID and original URL. It does not attach a title just because a search result has a similar name. Chapter metadata is matched by URL to retain the imported progress and bookmarks. Backend database IDs are scoped to their configured server and revalidated, including when a database is replaced at the same address.

If a source was removed, changed its URLs, or no longer provides a title, use **Migrate source** from the title details to select its replacement. Reading state and categories are carried over by chapter match. Select **Keep original title in library** to keep both entries; the original chapter files remain with the original title.

## Move downloaded chapter files

A Mihon backup contains chapter metadata, not image files. To transfer existing downloads, create one ZIP/CBZ per chapter containing its numbered images. On the PWA’s Backup page, choose the restored title as the **Chapter import destination** before selecting the chapter files. Keep exact chapter names when several releases share a chapter number. An ambiguous match produces an error instead of overwriting another chapter’s progress.

Files imported this way are available offline immediately and can be read even when their original extension is missing. Downloaded PWA chapters can be exported as CBZ from Downloads. A PWA JSON export contains metadata and original archives; move the CBZ files as well when changing devices.

## Return to Android

In **More → Backup & restore**, choose **Export for Mihon Android (.tachibk)**. This creates a new backup with the PWA's current reading state, library, categories and compatible source IDs. Install matching extensions in Mihon and restore the generated file. Export chapter images separately as CBZ. Keep JSON for browser-only sources or migrate them to a compatible source before generating the Android backup. Original archives remain separately available without modification.

## Vercel

The repository includes functions for `/api/proxy` and `/api/suwayomi`, plus nested-route rewrites in `vercel.json`. Set `SUWAYOMI_URL` to an address reachable by Vercel’s servers. Set credentials in Connections when the upstream server uses Basic authentication.

Vercel function request/response limits apply before the proxy runs. A large `.tachibk` upload or high-resolution chapter image can exceed those limits. Use your Node/Docker server, a direct HTTPS Suwayomi connection, or the server’s WebUI backup restore in that case. The Node proxy accepts backup bodies up to 128 MiB and streams images with cancellation and backpressure.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Connection works but no sources appear | Add an extension store under Browse → Extensions, refresh the catalog, then install the sources you need. Source availability refreshes automatically. Local source may be the only source on a new server. |
| A restored title cannot resolve | Copy the original archive to that server, verify the exact source ID is installed, or migrate the title to an available source. |
| Authentication fails | Enter Basic credentials. For backup uploads, use the bundled connection so the server’s session/CSRF cookies remain same-origin. |
| HTTPS app rejects an HTTP server URL | Put Suwayomi behind HTTPS or use the bundled HTTPS app proxy. |
| Download pauses when the screen locks | Reopen the installed app and resume the persistent queue. Keep the app visible while downloading on iOS. |
| Downloaded metadata exists but pages are missing | Download the chapter again or import its CBZ. Startup reconciliation clears stale downloaded flags. |
| A title works on Android but the server rejects its extension | Check Suwayomi’s extension compatibility and logs. Replace the source adapter or import chapter files; iOS cannot run Android APKs directly. |

## Live server contract check

This optional test **creates two synthetic local chapters and restores a synthetic library** on the selected server. Point it at a disposable Suwayomi data directory. Its fixtures contain generated app-icon PNGs and no personal reading data.

With a disposable server running on port 4568, set the URL and its data directory:

```powershell
$env:SUWAYOMI_TEST_URL = 'http://127.0.0.1:4568'
$env:SUWAYOMI_TEST_DATA = 'C:\Temp\suwayomi-test-data'
npm run test:server
```

For an authenticated instance, set `SUWAYOMI_TEST_USERNAME` and `SUWAYOMI_TEST_PASSWORD` in the process environment as well. The URL can point at the PWA’s `/api/suwayomi` proxy to check cookie scoping and authenticated multipart restoration.

The test imports the synthetic backup into the PWA, uploads the original bytes, polls server restoration, resolves the original source/URL, retrieves chapter pages, downloads their PNG bytes, disconnects the server, and verifies cached pages and bookmarks. Node’s test harness models a same-origin browser cookie jar. Physical iPhone behavior and arbitrary third-party extension endpoints still require device/source testing.
