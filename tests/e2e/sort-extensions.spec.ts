import { test, expect } from '@playwright/test';
import { concat, schemaBackup, preference, string, EXACT_SOURCE } from '../fixtures/mihon';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'fflate';
import { parseTachibk } from '../../src/backup/parser';
// API fixtures must go through Playwright rather than the service worker.
test.use({ serviceWorkers: 'block' });

async function restore(page: import('@playwright/test').Page) {
  await page.goto('/#/backup');
  const bytes = concat(schemaBackup(), preference('library_sorting_mode', 'StringPreferenceValue', string(1, 'LAST_READ,DESCENDING')));
  await page.getByLabel('Choose backup file').setInputFiles({ name: 'sort-fixture.tachibk', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await page.getByRole('button', { name: 'Restore 2 library titles' }).click();
  await expect(page.getByRole('heading', { name: '2 titles restored' })).toBeVisible();
}

test('restores last read sorting, changes direction, and persists it across a reload', async ({ page }, info) => {
  await page.addInitScript(() => { if (!localStorage.getItem('mihon-settings')) localStorage.setItem('mihon-settings', JSON.stringify({ librarySort: 'title', sortDescending: false })); });
  await restore(page);
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await expect(page.locator('.manga-pressable').first()).toHaveAttribute('aria-label', 'Open Schema Hero');
  await page.getByRole('button', { name: 'Sort library', exact: true }).click();
  await expect(page.getByLabel('Sort library by')).toHaveValue('read');
  await expect(page.getByLabel('Library sort order')).toHaveValue('descending');
  await page.getByLabel('Library sort order').selectOption('ascending');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.manga-pressable').first()).toHaveAttribute('aria-label', 'Open MangaDex fixture');
  await page.reload();
  await expect(page.locator('.manga-pressable').first()).toHaveAttribute('aria-label', 'Open MangaDex fixture');
  await page.screenshot({ path: info.outputPath('library-sorting.png'), fullPage: true });
});

test('shows available and missing library sources with stores retained from Android', async ({ page }, info) => {
  await restore(page);
  await page.goto('/#/browse');
  await expect(page.getByRole('button', { name: /^Browse MangaDex/ })).toBeVisible();
  await expect(page.getByText('Exact ID source', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Mihon extensions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect to load Mihon extensions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Extension store store', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('retained-extension-stores.png'), fullPage: true });
});

test('downloads a new Android backup and previews it for restoration', async ({ page }) => {
  await restore(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for Mihon Android (.tachibk)', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.tachibk$/);
  const bytes = await readFile((await download.path())!);
  const backup = parseTachibk(gunzipSync(bytes));
  expect(backup.manga.filter(m => m.favorite)).toHaveLength(2);
  expect(backup.manga.find(m => m.source === EXACT_SOURCE)?.history[0]?.lastRead).toBeGreaterThan(0);
  expect(backup.preferences.find(p => p.key === 'library_sorting_mode')?.value).toBe('LAST_READ,DESCENDING');
  await page.getByLabel('Choose backup file').setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/gzip', buffer: bytes });
  await expect(page.getByRole('heading', { name: 'Review Mihon backup' })).toBeVisible();
});

test('installs, updates, filters and uninstalls server extensions from Browse', async ({ page, context }, info) => {
  const base = 'http://localhost:4173/__fixture-server';
  const extension = { pkgName: 'fixture.en.hero', name: 'Fixture source', lang: 'en', versionName: '1.6.1', isInstalled: false, hasUpdate: false, isObsolete: false, isNsfw: false, storeIndexUrl: 'https://extensions.example/index.pb' };
  const spanish = { ...extension, pkgName: 'fixture.es.hero', lang: 'es' };
  const stores: { indexUrl: string; name: string }[] = [];
  const changes: unknown[] = [];
  await page.addInitScript(base => { localStorage.setItem('mihon-settings', JSON.stringify({ suwayomiUrl: base })); }, base);
  await context.route('**/__fixture-server/api/graphql', async route => {
    const { query, variables } = route.request().postDataJSON();
    let data: unknown;
    if (query.includes('query Sources')) data = { sources: { nodes: extension.isInstalled ? [{ id: EXACT_SOURCE.toString(), name: extension.name, lang: 'en', supportsLatest: true }] : [], totalCount: extension.isInstalled ? 1 : 0 } };
    else if (query.includes('ExtensionCatalog')) data = { extensions: { nodes: [extension, spanish], totalCount: 2 } };
    else if (query.includes('ExtensionStores')) data = { extensionStores: { nodes: stores } };
    else if (query.includes('RefreshExtensions')) data = { fetchExtensions: { clientMutationId: null } };
    else if (query.includes('AddExtensionStore')) { stores.push({ indexUrl: variables.input.indexUrl, name: 'Fixture store' }); data = { addExtensionStore: { extensionStore: stores.at(-1) } }; }
    else if (query.includes('RemoveExtensionStore')) { stores.length = 0; data = { removeExtensionStore: { clientMutationId: null } }; }
    else if (query.includes('ManageExtension')) {
      changes.push(variables.input);
      if (variables.input.patch.install) { extension.isInstalled = true; extension.hasUpdate = true; }
      if (variables.input.patch.update) { extension.hasUpdate = false; extension.versionName = '1.6.2'; }
      if (variables.input.patch.uninstall) extension.isInstalled = false;
      data = { updateExtension: { extension } };
    } else data = { fetchSourceManga: { mangas: [] } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  await page.goto('/#/browse');
  await page.getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Mihon extensions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Extensions · 2' })).toBeVisible();
  await page.getByLabel('Extension store URL').fill(extension.storeIndexUrl);
  await page.getByRole('button', { name: 'Add store', exact: true }).click();
  await expect(page.getByText('Fixture store', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Extension language').selectOption('en');
  const row = page.getByRole('article', { name: 'Fixture source EN extension' });
  await row.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(row).toContainText('v1.6.2');
  await expect(row.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Sources/ }).click();
  await expect(page.getByRole('button', { name: 'Browse Fixture source EN' })).toBeVisible();
  await page.getByRole('button', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Mihon extensions', exact: true }).click();
  await page.getByLabel('Extension status').selectOption('installed');
  await page.screenshot({ path: info.outputPath('mihon-extension-catalog.png'), fullPage: true });
  page.on('dialog', dialog => dialog.accept());
  await row.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: /^Sources/ }).click();
  await expect(page.getByRole('button', { name: 'Browse Fixture source EN' })).toHaveCount(0);
  expect(changes).toEqual([
    { id: extension.pkgName, patch: { install: true } },
    { id: extension.pkgName, patch: { update: true } },
    { id: extension.pkgName, patch: { uninstall: true } },
  ]);
});
