import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { handleMangaDexProxy, handleSuwayomiProxy } from './server/proxy.ts';
import { handleSourceProxy } from './server/sourceProxy.ts';
import { handleBrowserSessionProxy } from './server/browserBridge.ts';

function sourceProxy(): Plugin {
  const middleware = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: (error?: unknown) => void): void => {
      if (req.url?.startsWith('/api/proxy?')) void handleMangaDexProxy(req, res).catch(next);
      else if (req.url?.startsWith('/api/source?')) void handleSourceProxy(req, res).catch(next);
      else if (req.url?.startsWith('/api/source-browser?')) void handleBrowserSessionProxy(req, res).catch(next);
      else if (req.url?.startsWith('/api/suwayomi/')) void handleSuwayomiProxy(req, res).catch(next);
      else next();
    };
  return { name: 'mihon-source-proxy', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.SUWAYOMI_URL && !process.env.SUWAYOMI_URL) process.env.SUWAYOMI_URL = env.SUWAYOMI_URL;
  for (const name of ['SOURCE_BROWSER_URL', 'SOURCE_BROWSER_TOKEN']) if (env[name] && !process.env[name]) process.env[name] = env[name];
  return {
  plugins: [
    sourceProxy(),
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.svg', 'icons/*.png'],
      manifest: {
        name: 'Mihon PWA',
        short_name: 'Mihon',
        description: 'Your manga library, reading progress, and downloaded chapters. Available offline.',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        theme_color: '#121214',
        background_color: '#121214',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        skipWaiting: false,
        clientsClaim: true,
        // No runtime caching: iOS Safari mishandles service-worker caching
        // of cross-origin cover responses (broken images). Covers load from
        // the network; offline chapters come from explicit downloads, which
        // use the app's own Cache Storage code.
      },
    }),
  ],
  };
});
