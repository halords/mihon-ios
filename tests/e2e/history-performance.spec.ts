import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { svgPage } from '../fixtures/mihon';

test('keeps a large history bounded, searches older entries, and allows navigation during search', async ({ page }, info) => {
  test.setTimeout(90000);
  const historyCount = info.project.name.includes('webkit') ? 2000 : 20000;
  await page.goto('/#/more');
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
  await page.evaluate(async count => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('mihon-pwa'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    for (let start = 0; start < count; start += 1000) {
      const tx = db.transaction(['history', 'chapterMeta'], 'readwrite');
      for (let index = start; index < start + 1000; index++) {
        const key = 'missing-source::hero::' + String(index).padStart(5, '0');
        tx.objectStore('history').put({ key, mangaKey: 'missing-source::hero', mangaTitle: index === 0 ? 'Older only' : 'History Hero', chapterName: 'Chapter ' + (index + 1), page: index, updatedAt: 1700000000000 + index, coverUrl: '' });
        tx.objectStore('chapterMeta').put({ key, mangaKey: 'missing-source::hero', chapter: { id: String(index), mangaId: 'hero', name: 'Chapter ' + index, number: index, dateUpload: 1 } });
      }
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    }
    db.close();
  }, historyCount);
  const started = Date.now();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(40);
  test.info().annotations.push({ type: 'history-open-ms', description: String(Date.now() - started) });
  await expect(page.locator('.history-row').first()).toContainText('Chapter ' + historyCount);
  await page.screenshot({ path: info.outputPath('bounded-history.png') });
  await page.getByRole('button', { name: 'Older history', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(40);
  await expect(page.locator('.history-row').first()).toContainText('Chapter ' + (historyCount - 40));
  await page.getByRole('button', { name: 'Newer history', exact: true }).click();
  await expect(page.locator('.history-row').first()).toContainText('Chapter ' + historyCount);
  await page.getByLabel('Search reading history').fill('Older only');
  await expect(page.locator('.history-row')).toHaveCount(1, { timeout: 20000 });
  await expect(page.locator('.history-row')).toContainText('Chapter 1');
  await page.getByLabel('Search reading history').fill(' Older only ');
  await expect(page.locator('.history-row')).toHaveCount(1);
  await page.getByLabel('Search reading history').fill('no matching title');
  await page.getByRole('button', { name: 'More', exact: true }).click({ timeout: 3000 });
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: 'Browse', exact: true }).click();
  await expect(page.locator('.source-browse-row')).toHaveCount(4);
});

test('shows only twenty updates per page and retains older entries', async ({ page }) => {
  await page.goto('/#/more');
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('mihon-pwa'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction(['library', 'metadata', 'chapterState'], 'readwrite');
    const key = 'missing-source::updates';
    tx.objectStore('library').put({ key, category: 'Reading', addedAt: 1 });
    const chapters = Array.from({ length: 95 }, (_, index) => ({ mangaKey: key, mangaTitle: 'Updates Hero', coverUrl: '', chapter: { id: String(index), mangaId: 'updates', name: 'Chapter ' + (95 - index), number: 95 - index, dateUpload: 1 }, foundAt: 1700000000000 - index }));
    tx.objectStore('metadata').put({ key: 'library:updates', value: { chapters, lastChecked: 1700000000000, checked: 1, found: 95, failures: [], unavailable: 0 } });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  });
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await expect(page.locator('.update-row')).toHaveCount(20);
  await expect(page.locator('.update-row').first()).toContainText('Chapter 95');
  await page.getByRole('button', { name: 'Older updates', exact: true }).click();
  await expect(page.locator('.update-row')).toHaveCount(20);
  await expect(page.locator('.update-row').first()).toContainText('Chapter 75');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible();
});

test('removes downloaded files with a library title and reads a retained title from its normal chapter view offline', async ({ page, context }) => {
  function chapterFile(name: string) { return { name, mimeType: 'application/vnd.comicbook+zip', buffer: Buffer.from(zipSync({ '1.svg': strToU8(svgPage('Page one', 800, 3000)), '2.svg': strToU8(svgPage('Page two', 800, 3000)) })) }; }
  await page.goto('/#/backup');
  await page.getByPlaceholder('Use one title to group chapter files').fill('Removal Hero');
  await page.getByLabel('Import CBZ chapter files').setInputFiles(chapterFile('Chapter 1.cbz'));
  await expect(page.getByRole('status').filter({ hasText: '1 chapter files imported' })).toBeVisible();
  await page.getByPlaceholder('Use one title to group chapter files').fill('Keep Hero');
  await page.getByLabel('Import CBZ chapter files').setInputFiles(chapterFile('Chapter 2.cbz'));
  await expect(page.getByRole('status').filter({ hasText: '1 chapter files imported' })).toBeVisible();
  await page.goto('/#/library');
  await page.getByRole('button', { name: 'Open Removal Hero', exact: true }).click({ button: 'right' });
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove selected titles from library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Removal Hero', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open('mihon-pages-v1');
    return (await cache.keys()).filter(request => decodeURIComponent(request.url).includes('local::removal%20hero')).length;
  })).toBe(0);
  await page.getByRole('button', { name: 'Open Keep Hero', exact: true }).click();
  await page.getByRole('button', { name: /Start reading/ }).click();
  await expect.poll(() => page.locator('.reader-page img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.locator('.reader-screen').evaluate(element => { element.scrollTop = 550; });
  await expect.poll(() => page.locator('.reader-screen').evaluate(element => element.scrollTop)).toBeGreaterThan(530);
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('mihon-pwa'); request.onsuccess = () => resolve(request.result); });
    const state = await new Promise<{ pageOffset?: number } | undefined>(resolve => { const request = db.transaction('chapterState').objectStore('chapterState').getAll(); request.onsuccess = () => resolve(request.result.find((row: { mangaKey: string }) => row.mangaKey === 'local::keep%20hero')); }); db.close();
    return state?.pageOffset ?? 0;
  })).toBeGreaterThan(.3);
  await context.setOffline(true); await page.reload();
  await expect.poll(() => page.locator('.reader-page img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect.poll(() => page.locator('.reader-screen').evaluate(element => element.scrollTop)).toBeGreaterThan(530);
});
