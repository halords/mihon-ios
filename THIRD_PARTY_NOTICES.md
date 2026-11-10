# Third-party source references

The built-in source adapters include TypeScript ports of source formats and request logic from **Keiyoushi extensions-source**, distributed under the Apache License, Version 2.0.

- Upstream: https://github.com/keiyoushi/extensions-source
- Reference revision: `1b7089818edf1e36bf71256369e4c6f36bbd9158`
- License: [Apache License 2.0](docs/licenses/keiyoushi-Apache-2.0.txt)
- Referenced files: `lib-multisrc/mangahub`, `lib-multisrc/mangabox`, `lib-multisrc/yiimadara`, `src/en/kissmangain`, `src/en/asurascans`, `src/en/mangafox`, and each matching source's domain configuration.
- Modified files: `src/sources/mangahubSource.ts`, `src/sources/htmlSources.ts`, `src/sources/asuraSource.ts`, and `src/lib/sourceImages.ts` translate the relevant request/parsing/decoding behavior to browser TypeScript and integrate the PWA's storage and source proxy.

The Kotlin/Android APK implementations are not bundled or executed. Source websites and their content remain operated by their respective owners. This project is independent of Mihon and Keiyoushi.

The bundled PNG source icons come from the matching Keiyoushi extension `res/mipmap-xxxhdpi/ic_launcher.png` resources at the reference revision above. MangaLife uses its original `src/en/mangalife` icon at revision `7a140a79970b9beb2e0cbe63349a1201668f8597`, before that extension was removed. Icons identify the original sources; their names and marks belong to their respective owners.

The browser backend uses Playwright (Apache-2.0): https://github.com/microsoft/playwright. `browser-server/seccomp_profile.json` is its Docker Chromium sandbox profile, copied from Playwright v1.65.0 (`utils/docker/seccomp_profile.json`).
