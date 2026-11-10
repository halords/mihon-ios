import { test, expect, type Page, type Locator } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function seedChapters(page: Page, sourceId = '6247824327199706550') {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible();
  const mangaKey = sourceId + '::selection-fixture';
  await page.evaluate(async ({ mangaKey, sourceId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mihon-pwa');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['manga', 'chapterMeta', 'chapterState'], 'readwrite');
    tx.objectStore('manga').put({ key: mangaKey, manga: { id: 'selection-fixture', sourceId, title: 'Selection Fixture', description: '', genres: [], status: 'Ongoing', coverUrl: '' }, updatedAt: 1 });
    for (let number = 1; number <= 8; number++) {
      const key = mangaKey + '::chapter-' + number;
      tx.objectStore('chapterMeta').put({ key, mangaKey, chapter: { id: 'chapter-' + number, mangaId: 'selection-fixture', name: 'Chapter ' + number, number, dateUpload: Date.UTC(2026, 10, number), scanlator: 'A very long scanlator name for mobile layout' } });
      tx.objectStore('chapterState').put({ key, mangaKey, read: number % 2 === 0, lastPage: 3, pageOffset: .4, bookmark: number === 4, downloaded: false });
    }
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, { mangaKey, sourceId });
  await page.goto('/#/details?' + new URLSearchParams({ manga: mangaKey }));
  await expect(page.locator('.chapter-row')).toHaveCount(8);
  return mangaKey;
}

function chapter(page: Page, number: number) {
  return page.locator('.chapter-open').filter({ has: page.locator('.chapter-title', { hasText: new RegExp('^Chapter ' + number + '$') }) });
}

async function hold(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const rect = (await target.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  try { await expect(target).toHaveAttribute('aria-pressed', 'true'); }
  finally { await page.mouse.up(); }
}

async function states(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('mihon-pwa'); request.onsuccess = () => resolve(request.result); });
    const rows = await new Promise<any[]>(resolve => { const request = db.transaction('chapterState').objectStore('chapterState').getAll(); request.onsuccess = () => resolve(request.result); });
    db.close(); return rows;
  });
}

test('holds two chapter endpoints, adjusts the range, and marks only the selection unread', async ({ page }, info) => {
  const key = await seedChapters(page);
  const before = await states(page);
  await expect(page.locator('.chapter-section input[type="checkbox"]')).toHaveCount(0);
  await hold(page, chapter(page, 8));
  await hold(page, chapter(page, 4));
  await expect(page.locator('.chapter-row.selected')).toHaveCount(5);
  expect(await states(page)).toEqual(before);
  await expect(page).toHaveURL(new RegExp('/details\\?'));
  await chapter(page, 6).click();
  await expect(page.locator('.chapter-row.selected')).toHaveCount(4);
  await expect(chapter(page, 6)).toHaveAttribute('aria-pressed', 'false');
  const toolbar = page.getByRole('toolbar', { name: 'Selected chapter actions' });
  await expect(toolbar).toBeVisible();
  await page.screenshot({ path: info.outputPath('range-selection.png') });
  await toolbar.getByRole('button', { name: 'Mark selected chapters as unread' }).click();
  await expect(toolbar).toHaveCount(0);
  const after = await states(page);
  for (const row of after) {
    const number = Number(row.key.split('chapter-')[1]);
    if ([4, 5, 7, 8].includes(number)) expect(row).toMatchObject({ read: false, lastPage: 0, pageOffset: 0, downloaded: false, bookmark: number === 4 });
    else expect(row).toEqual(before.find(previous => previous.key === row.key));
  }
  await page.reload();
  await expect(page.locator('.chapter-row.is-read')).toHaveCount(2);
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(key)));
});

test('selects a range in reverse and works with an unavailable source', async ({ page }) => {
  await seedChapters(page, 'not-installed');
  await expect(chapter(page, 2)).toHaveAttribute('aria-disabled', 'true');
  await hold(page, chapter(page, 2));
  await hold(page, chapter(page, 5));
  await expect(page.locator('.chapter-row.selected')).toHaveCount(4);
  await page.getByRole('button', { name: 'Mark selected chapters as read' }).click();
  await expect(page.getByRole('toolbar')).toHaveCount(0);
  for (const row of await states(page)) {
    const number = Number(row.key.split('chapter-')[1]);
    expect(row.read).toBe([2, 3, 4, 5, 6, 8].includes(number));
  }
  await page.reload();
  await expect(page.locator('.chapter-row.is-read')).toHaveCount(6);
});

test('uses visible filtered order, cancels scroll holds, and keeps the date inline on narrow screens', async ({ page }, info) => {
  await seedChapters(page);
  const target = chapter(page, 8);
  await target.dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: 50, clientY: 50 });
  await target.dispatchEvent('pointermove', { pointerId: 1, isPrimary: true, pointerType: 'touch', clientX: 50, clientY: 90 });
  await target.dispatchEvent('pointercancel', { pointerId: 1, isPrimary: true, pointerType: 'touch' });
  await page.waitForTimeout(550);
  await expect(page.locator('.chapter-row.selected')).toHaveCount(0);
  await expect(page.getByRole('toolbar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Filter chapters', exact: true }).click();
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('unread');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.chapter-row')).toHaveCount(4);
  await hold(page, chapter(page, 7));
  await hold(page, chapter(page, 1));
  await expect(page.locator('.chapter-row.selected')).toHaveCount(4);
  await page.getByRole('button', { name: 'Cancel chapter selection' }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  const layout = await page.locator('.chapter-meta').evaluateAll(rows => rows.map(row => {
    const status = row.querySelector('.chapter-reading-state')!.getBoundingClientRect();
    const date = row.querySelector('time')!.getBoundingClientRect();
    return { statusTop: status.top, dateTop: date.top, fits: row.scrollWidth <= row.clientWidth + 1 };
  }));
  for (const row of layout) { expect(Math.abs(row.statusTop - row.dateTop)).toBeLessThan(3); expect(row.fits).toBe(true); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.chapter-section').screenshot({ path: info.outputPath('compact-chapters.png') });
  await page.getByRole('button', { name: 'Select chapters', exact: true }).focus();
  await page.getByRole('button', { name: 'Select chapters', exact: true }).press('Enter');
  await chapter(page, 7).hover();
  await chapter(page, 7).focus();
  await chapter(page, 7).press('Enter');
  await chapter(page, 3).click({ modifiers: ['Shift'] });
  await expect(page.locator('.chapter-row.selected')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Mark selected chapters as read' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Mark selected chapters as unread' })).toBeInViewport();
});
