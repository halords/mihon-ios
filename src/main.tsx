import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initPlugins } from './lib/plugins'
import { initSuwayomi } from './lib/suwayomi'
import { initDownloadQueue } from './lib/downloadQueue'
import { reconcileDownloads } from './lib/downloads'
import { initAccount } from './lib/account'

// Local-first app: ask the browser to keep our on-device data (library,
// progress, downloads) safe from automatic storage eviction. Best effort —
// the user can also request it explicitly from Settings.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  void navigator.storage.persist().catch(() => undefined)
}

// Load installed extension plugins into the source registry before first
// render. A broken plugin never blocks the app (see src/lib/plugins.ts).
async function boot(): Promise<void> {
  try {
    await initPlugins()
  } catch {
    // Registry keeps the built-in sources; boot regardless.
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  void initAccount().catch(() => undefined)
  void (async () => {
    try { await initSuwayomi(); await reconcileDownloads(); await initDownloadQueue(); }
    catch { /* An unavailable storage API or connection must not block the shell. */ }
  })()
}

void boot()
