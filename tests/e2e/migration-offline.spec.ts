import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { schemaFile, svgPage, EXACT_SOURCE } from '../fixtures/mihon';

async function readyOffline(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function restoreFixture(page: Page) {
  await page.goto('/#/backup');
  await page.getByLabel('Choose backup file').setInputFiles({ name: 'schema-fixture.tachibk', mimeType: 'application/gzip', buffer: Buffer.from(await schemaFile().arrayBuffer()) });
  await expect(page.getByRole('heading', { name: 'Review Mihon backup' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore 2 library titles' }).click();
  await expect(page.getByRole('heading', { name: '2 titles restored' })).toBeVisible();
}
function cbz(name: string, count = 4, height = 1200) {
  return { name, mimeType: 'application/vnd.comicbook+zip', buffer: Buffer.from(zipSync(Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1) + '.svg', strToU8(svgPage('Offline page ' + (i + 1), 800, height))])))) };
}
async function showControls(page: Page) {
  if (!await page.locator('.reader-chrome--top').isVisible()) await page.locator('.reader-screen').click({ position: { x: 190, y: 240 } });
}
async function assertImage(page: Page, selector = '.reader-page img') {
  await expect.poll(async () => page.locator(selector).evaluateAll(images => images.some(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
}
test('restores all Mihon metadata through preview and organizes multiple categories', async ({ page }, info) => {
  await restoreFixture(page);
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Schema Hero' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open MangaDex fixture' })).toBeVisible();
  await page.getByRole('button', { name: /^Reading\s*1$/ }).click();
  await expect(page.getByRole('button', { name: 'Open Schema Hero' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open MangaDex fixture' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('migrated-library.png'), fullPage: true });
  await page.getByRole('button', { name: 'Open Schema Hero' }).click();
  await expect(page.getByText('Your library is restored. Connect this source to read.')).toBeVisible();
  await page.getByText('Imported tracking · 1').click();
  await expect(page.getByText('Tracked title', { exact: true })).toBeVisible();
});
test('attaches Android chapter files to an imported title and cold-reloads the reader offline', async ({ page, context }, info) => {
  await restoreFixture(page);
  const key = EXACT_SOURCE + '::/series/hero';
  await page.getByLabel('Chapter import destination').selectOption(key);
  await page.getByLabel('Import CBZ chapter files').setInputFiles(cbz('Chapter 2.cbz'));
  await expect(page.getByRole('status').filter({ hasText: '1 chapter files imported' })).toBeVisible();
  await readyOffline(page);
  await page.goto('/#/details?' + new URLSearchParams({ manga: key }));
  await page.getByRole('button', { name: /Continue reading/ }).click();
  await assertImage(page);
  await expect(page.getByLabel('Seek to page')).toHaveValue('4');
  await expect(page.getByRole('heading', { name: 'Chapter complete' })).toHaveCount(0);
  await context.setOffline(true);
  await page.reload();
  await assertImage(page);
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Seek to page')).toHaveValue('4');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chapter complete' })).toBeVisible();
  await page.getByRole('button', { name: 'Return to last page' }).click();
  await page.getByRole('button', { name: 'Right to left', exact: true }).click();
  await page.getByLabel('Reading mode', { exact: true }).selectOption('vertical');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await assertImage(page);
  expect(await page.locator('.reader-screen').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('offline-reader.png') });
  await showControls(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schema Hero', exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible();
});
test('preserves scroll offsets inside the first page after an offline reload', async ({ page, context }) => {
  await page.goto('/#/backup');
  await page.getByPlaceholder('Use one title to group chapter files').fill('Long Webtoon');
  await page.getByLabel('Import CBZ chapter files').setInputFiles(cbz('Chapter 1.cbz', 3, 3000));
  await expect(page.getByRole('status').filter({ hasText: '1 chapter files imported' })).toBeVisible();
  await readyOffline(page);
  const key = 'local::long%20webtoon';
  await page.goto('/#/details?' + new URLSearchParams({ manga: key }));
  await page.getByRole('button', { name: /Start reading/ }).click();
  await assertImage(page);
  await page.locator('.reader-screen').evaluate(el => { el.scrollTop = 550; });
  await expect.poll(async () => page.locator('.reader-screen').evaluate(el => Math.round(el.scrollTop))).toBe(550);
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('mihon-pwa'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const state = await new Promise<any>(resolve => { const r = db.transaction('chapterState').objectStore('chapterState').getAll(); r.onsuccess = () => resolve(r.result[0]); }); db.close();
    return state?.pageOffset ?? 0;
  })).toBeGreaterThan(.3);
  await context.setOffline(true);
  await page.reload();
  await assertImage(page);
  await expect.poll(async () => page.locator('.reader-screen').evaluate(el => Math.round(el.scrollTop))).toBeGreaterThan(530);
  await expect(page.getByLabel('Seek to page')).toHaveValue('1');
});
test('downloads chapters from a source, persists its queue, and reads them offline', async ({ page, context }, info) => {
  await page.goto('/#/browse');
  await page.getByRole('button', { name: 'Titles', exact: true }).click();
  await page.getByLabel('Browse source').selectOption('sample');
  await page.getByRole('button', { name: 'Open Starfall Blade' }).click();
  await page.getByRole('button', { name: 'Add to library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'In library', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('button', { name: /Next 5 unread chapters/ }).click();
  await expect(page.getByText('3 chapters available offline')).toBeVisible({ timeout: 30000 });
  await readyOffline(page);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('button', { name: /Downloaded 3/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('download-manager.png'), fullPage: true });
  await context.setOffline(true);
  await page.reload();
  await page.locator('.download-chapter-open').first().click();
  await assertImage(page);
  expect(await page.locator('.reader-screen').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
test('keeps working browse results when another source fails', async ({ page, context }) => {
  await context.route('**/api/proxy?*', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Unavailable test source"}' }));
  await page.goto('/#/browse');
  await page.getByRole('button', { name: 'Titles', exact: true }).click();
  await page.getByLabel('Browse source').selectOption('all');
  await expect(page.getByRole('button', { name: 'Open Starfall Blade' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('HTTP 502');
});

test('installs relative extension indexes and retains class methods and private state across offline restarts', async ({ page, context }, info) => {
  const svg = 'data:image/svg+xml,' + encodeURIComponent(svgPage('Prototype page'));
  const module = `
    class ReadingSource {
      #title = 'Prototype Hero';
      kind = 'extension';
      get id() { return 'prototype-source'; }
      get name() { return 'Prototype source'; }
      async getPopularManga() { return [{id:'hero',sourceId:this.id,title:this.#title,description:'Class extension',genres:[],status:'Ongoing',coverUrl:${JSON.stringify(svg)}}]; }
      getLatestUpdates() { return this.getPopularManga(); }
      searchManga() { return this.getPopularManga(); }
      async getMangaDetails() { return (await this.getPopularManga())[0]; }
      async getChapterList() { return [{id:'1',mangaId:'hero',name:'Chapter 1',number:1,dateUpload:0}]; }
      async getPageList() { if (this.#title !== 'Prototype Hero') throw new Error('Missing instance state'); return [{imageUrl:${JSON.stringify(svg)}}]; }
    }
    export default new ReadingSource();
  `;
  // Service-worker requests can bypass WebKit's route mocks. Serve this
  // fixture from the actual HTTP server, with a separate path per project.
  const root = resolve('dist');
  const folder = resolve(root, '__test', info.project.name, 'class-extension');
  if (!folder.startsWith(root + sep)) throw new Error('Invalid fixture directory');
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, 'index.json'), JSON.stringify({ name: 'Class fixture index', sources: [{ id: 'prototype-source', name: 'Prototype source', version: '1', moduleUrl: 'source.mjs' }] }));
  await writeFile(resolve(folder, 'source.mjs'), module);
  try {
  await page.goto('/#/extensions');
  await page.getByRole('button', { name: 'Web extensions', exact: true }).click();
  await page.locator('input[type="url"]').fill(`/__test/${info.project.name}/class-extension/index.json`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const index = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Class fixture index' }) });
  await index.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Installed Prototype source');
  await page.goto('/#/browse');
  await page.getByRole('button', { name: 'Titles', exact: true }).click();
  await page.getByLabel('Browse source').selectOption('prototype-source');
  await page.getByRole('button', { name: 'Open Prototype Hero' }).click();
  await page.getByRole('button', { name: 'Add to library', exact: true }).click();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('button', { name: /Next 5 unread chapters/ }).click();
  await expect(page.getByText('1 chapters available offline')).toBeVisible();
  await readyOffline(page);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: /Start reading/ }).click();
  await assertImage(page);
  } finally {
    await unlink(resolve(folder, 'index.json'));
    await unlink(resolve(folder, 'source.mjs'));
    await rmdir(folder);
    await rmdir(resolve(folder, '..'));
    await rmdir(resolve(root, '__test')).catch(() => {});
  }
});
