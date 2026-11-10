import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base, testMatch: '**/account-sync.spec.ts', testIgnore: [],
  use: { ...base.use, baseURL: 'http://localhost:4176', serviceWorkers: 'allow' },
  timeout: 90000,
  webServer: { command: 'node scripts/run-sync-test-server.mjs', url: 'http://localhost:4176', reuseExistingServer: false, timeout: 30000 },
});
