import { test, expect, type Page } from '@playwright/test';

async function seedDevice(page: Page) {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('mihon-pwa'); request.onsuccess = () => resolve(request.result); });
    const key = 'mangadex::sync-hero'; const chapterKey = key + '::chapter-1';
    const tx = db.transaction(['manga', 'library', 'chapterMeta', 'chapterState', 'history', 'archives'], 'readwrite');
    tx.objectStore('manga').put({ key, manga: { id: 'sync-hero', sourceId: 'mangadex', title: 'Synced Hero', coverUrl: '', genres: [], description: '', status: 'Ongoing' }, updatedAt: 10 });
    tx.objectStore('library').put({ key, category: 'Reading', categories: ['Reading'], addedAt: 20 });
    tx.objectStore('chapterMeta').put({ key: chapterKey, mangaKey: key, chapter: { id: 'chapter-1', mangaId: 'sync-hero', name: 'Chapter 1', number: 1, dateUpload: 1000 } });
    tx.objectStore('chapterState').put({ key: chapterKey, mangaKey: key, read: true, lastPage: 8, lastReadAt: 100, downloaded: false, bookmark: true });
    tx.objectStore('history').put({ key: chapterKey, mangaKey: key, mangaTitle: 'Synced Hero', chapterName: 'Chapter 1', coverUrl: '', page: 8, updatedAt: 100, readDuration: 1000 });
    tx.objectStore('archives').put({ id: 'fixture-original', name: 'fixture.tachibk', bytes: new Uint8Array([1, 2, 3]), importedAt: 10, mangaCount: 1, chapterCount: 1 });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  });
}
async function auth(page: Page, email: string, register = false) {
  await page.goto('/#/account');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  if (register) await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a strong fixture password');
  await page.getByRole('button', { name: register ? 'Create account & sync' : 'Sign in', exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(page.getByText('Your library is in sync', { exact: true })).toBeVisible();
}
async function local(page: Page, store: string) {
  return page.evaluate(async store => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('mihon-pwa'); request.onsuccess = () => resolve(request.result); });
    const records = await new Promise<any[]>(resolve => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); });
    db.close(); return records;
  }, store);
}
async function markUnread(page: Page) {
  await page.goto('/#/details?' + new URLSearchParams({ manga: 'mangadex::sync-hero' }));
  await page.getByRole('button', { name: 'Options for Chapter 1' }).click();
  await page.getByRole('button', { name: 'Mark as unread', exact: true }).click();
  await expect(page.locator('.chapter-row.is-read')).toHaveCount(0);
}

test('automatically syncs the imported library, history, offline unread marks and removals across devices', async ({ page, browser }, info) => {
  const email = `sync-${info.project.name}-${crypto.randomUUID()}@example.com`;
  await seedDevice(page); await auth(page, email, true);
  expect(await local(page, 'archives')).toHaveLength(1);
  await expect(page.getByRole('heading', { name: 'Save your recovery code' })).toBeVisible();
  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  const second = await secondContext.newPage();
  try {
    await auth(second, email);
    expect(await local(second, 'library')).toHaveLength(1);
    expect(await local(second, 'history')).toMatchObject([{ mangaTitle: 'Synced Hero', page: 8 }]);
    expect(await local(second, 'chapterState')).toMatchObject([{ read: true, bookmark: true, downloaded: false }]);
    await second.goto('/#/library');
    await expect(second.getByRole('button', { name: 'Open Synced Hero', exact: true })).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.context().setOffline(true); await markUnread(page);
    await page.reload(); await expect(page.locator('.chapter-row')).toHaveCount(1);
    await page.context().setOffline(false);
    // No Sync now click: both upload on reconnect and polling on device two
    // must work automatically after a cold reload.
    await expect.poll(async () => (await local(second, 'chapterState'))[0]?.read, { timeout: 25000 }).toBe(false);
    expect((await local(second, 'chapterState'))[0]).toMatchObject({ lastPage: 0, bookmark: true });
    await page.goto('/#/library');
    const card = page.getByRole('button', { name: 'Open Synced Hero', exact: true });
    await card.click({ button: 'right' });
    page.on('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Remove selected titles from library' }).click();
    await expect.poll(async () => (await local(second, 'library')).length, { timeout: 25000 }).toBe(0);
    expect(await local(second, 'history')).toHaveLength(1);
    await page.goto('/#/account');
    await page.screenshot({ path: info.outputPath('account-sync.png'), fullPage: true });
  } finally { await secondContext.close(); }
});

test('keeps accounts isolated and retains each account on the device after signing out', async ({ page }, info) => {
  const suffix = info.project.name + '-' + crypto.randomUUID(); const a = 'a-' + suffix + '@example.com'; const b = 'b-' + suffix + '@example.com';
  await seedDevice(page); await auth(page, a, true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect(await local(page, 'library')).toHaveLength(1);
  await auth(page, b, true);
  expect(await local(page, 'library')).toHaveLength(0); expect(await local(page, 'history')).toHaveLength(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await auth(page, a);
  expect(await local(page, 'library')).toHaveLength(1); expect(await local(page, 'history')).toHaveLength(1);
  await page.getByRole('button', { name: 'Import & export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export PWA library (.json)', exact: true })).toBeVisible();
});
