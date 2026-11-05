import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.svg'],
      manifest: {
        name: 'Mihon PWA',
        short_name: 'Mihon',
        description: 'A Mihon-style manga reader for the web',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        theme_color: '#121214',
        background_color: '#121214',
        icons: [
          {
            src: '/icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/icons/maskable.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        runtimeCaching: [
          {
            // MangaDex covers: cache-first so the library and history look
            // right offline. Chapter pages are NOT runtime-cached; offline
            // chapters come from explicit downloads (Cache Storage).
            urlPattern: /^https:\/\/uploads\.mangadex\.org\/covers\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mangadex-covers-v1',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
