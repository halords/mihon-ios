# Browser sessions for the PWA

The dedicated service runs Chromium on your Ubuntu VPS. Open **More → Connections → Browser verification**, choose a source, and press **Open source browser**. The view shows the actual server-side browser; taps, scrolling and text entry are sent only when you operate its controls. Complete any website verification yourself, then press **Use this session** and return to Browse or migration.

Requests and images then use that browser's session, cookies and connection. The PWA stays installable through Safari. No Mac, iOS app or Apple developer membership is required. The service supports all built-in backup sources and imposes no session or source count cap. Android APK extensions still use Suwayomi; MangaDex keeps its existing API adapter.

This does not guarantee access: a website can reject the VPS IP, Chromium, or subsequent requests. Certificate errors remain enforced. There is no automated challenge solver. Opening the website in Safari creates a different session from the VPS browser.

## Ubuntu with Docker

Use Ubuntu 22.04 or 24.04 and Docker Engine with the Compose plugin. Point your domain's DNS to the VPS, and allow TCP 80/443 through Ubuntu and Oracle's security rules. The browser port stays private on the Docker network.

```sh
git clone https://github.com/halords/mihon-ios.git
cd mihon-ios
cp .env.example .env
openssl rand -hex 32
```

Edit `.env`: put the generated value in `SOURCE_BROWSER_TOKEN`, and set `MIHON_DOMAIN` to your domain. Keep the token private; it belongs on the app and browser servers, never in `VITE_*` variables or browser settings.

```sh
docker compose -f compose.browser.yaml up -d --build
docker compose -f compose.browser.yaml logs --tail=50 app browser https
```

The image uses the matching official Playwright browser distribution, an unprivileged browser user, and Playwright's seccomp profile for the Chromium sandbox. The app image contains the source configuration required by its proxy. Docker was unavailable in the Windows development environment, so container startup must be verified on the VPS.

## A 1 GB Oracle VM

All sources remain available, with no fixed session count limit. Chromium uses substantially more RAM than the PWA's HTTP service; multiple active sessions can exhaust a 1 GB VM. Browser contexts close after three idle minutes, their cookies are retained for up to 24 hours, and Chromium shuts down when there are no active contexts. The next request reopens it with the saved session.

Optional swap can reduce crashes during builds or memory spikes, but does not replace RAM. If `/swapfile` does not already exist, the standard Ubuntu setup is:

```sh
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

Add `/swapfile none swap sw 0 0` to `/etc/fstab` to retain it after reboot. Check existing swap first with `swapon --show`, available storage with `df -h`, and memory with `free -h`. No memory or concurrency cap is imposed by the application.

## Keep the PWA on Vercel

Host only the `browser` service on your VPS behind trusted HTTPS. Set the same `SOURCE_BROWSER_TOKEN` on both servers, and set `SOURCE_BROWSER_URL=https://your-private-browser-service.example` in the PWA host's server environment. The service requires bearer authentication on every endpoint. Prefer a firewall allowing only your app's gateway where your hosting provides stable outbound addresses. Do not expose its unauthenticated port or use HTTP over the public internet.

The PWA's `/api/source-browser` and `/api/source` functions forward requests to the VPS. A static-only host still needs those functions. Build and redeploy the PWA after updating this repository; server environment changes also need redeployment.

## Direct Node hosting

For an Ubuntu user with Node 22.18+ installed:

```sh
npm ci
npx playwright install --with-deps chromium
npm run build
```

Configure `.env` with a random shared token and `SOURCE_BROWSER_URL=http://127.0.0.1:4190`. Run `npm run start:browser` and `npm start` as an unprivileged user under your process manager; put the PWA behind HTTPS. Keep the browser service bound to localhost. Chromium's sandbox is enabled on Linux and requires working user namespaces.

## Session storage and troubleshooting

- A random HttpOnly cookie on the PWA selects an isolated VPS session. Website cookies never appear in the UI or backups. Visitor sessions do not share cookies.
- The Docker `browser-state` volume contains private website session data. Keep it private. Removing the volume clears verification sessions, so the source will need verification again.
- **Browser backend needs setup** means the app host lacks a reachable URL/token pair. Check `.env`, container logs or Vercel's server environment.
- **Website verification required** means the source blocked the request. Open its browser view and complete the check, then retry. If the website still denies that browser/IP, use migration to an available source.
- A stale or broken website cannot be repaired by a browser session. MangaLife's original extension domain is `manga4life.com`; it currently fails DNS resolution from the verification host.

Development validation exercises manual session activation, cookie reuse, cross-origin image bytes, session isolation and recovery after idle shutdown against a synthetic website. Live MangaHub access on your Oracle VPS and physical iPhone interaction must be checked after installation.
