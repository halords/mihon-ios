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
        // No runtime caching: iOS Safari mishandles service-worker caching
        // of cross-origin cover responses (broken images). Covers load from
        // the network; offline chapters come from explicit downloads, which
        // use the app's own Cache Storage code.
      },
    }),
  ],
});
