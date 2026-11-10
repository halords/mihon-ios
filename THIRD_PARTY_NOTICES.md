# Third-party source references

The built-in source adapters include TypeScript ports of source formats and request logic from **Keiyoushi extensions-source**, distributed under the Apache License, Version 2.0.

- Upstream: https://github.com/keiyoushi/extensions-source
- Reference revision: `1b7089818edf1e36bf71256369e4c6f36bbd9158`
- License: [Apache License 2.0](docs/licenses/keiyoushi-Apache-2.0.txt)
- Referenced files: `lib-multisrc/mangahub`, `lib-multisrc/mangabox`, `lib-multisrc/yiimadara`, `src/en/kissmangain`, `src/en/asurascans`, `src/en/mangafox`, and each matching source's domain configuration.
- Modified files: `src/sources/mangahubSource.ts`, `src/sources/htmlSources.ts`, `src/sources/asuraSource.ts`, and `src/lib/sourceImages.ts` translate the relevant request/parsing/decoding behavior to browser TypeScript and integrate the PWA's storage and source proxy.

The Kotlin/Android APK implementations are not bundled or executed. Source websites and their content remain operated by their respective owners. This project is independent of Mihon and Keiyoushi.
