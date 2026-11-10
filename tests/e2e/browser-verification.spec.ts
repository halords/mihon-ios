import { test, expect } from '@playwright/test';
test.use({ serviceWorkers: 'block' });
test('operates a source browser and uses its session for API and image routing', async ({ page }, info) => {
  const controls: Record<string, unknown>[] = [];
  const sourceRequests: string[] = [];
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  await page.context().route('**/api/source-browser?*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('status') === '1') return route.fulfill({ contentType: 'application/json', body: '{"configured":true}' });
    if (route.request().method() === 'POST') controls.push(route.request().postDataJSON());
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: true, image: pixel, title: 'Source browser fixture', width: 390, height: 680, url: 'https://mangahub.io/', requiresVerification: true }) });
  });
  await page.context().route('**/api/source?*', async route => {
    sourceRequests.push(route.request().url());
    await route.fulfill({ contentType: 'application/json', body: '{"data":{"search":{"rows":[{"slug":"hero","title":"Browser Session Hero","image":"hero.jpg"}]}}}' });
  });
  await page.goto('/#/connections?source=4758858684982406533');
  await expect(page.getByText('Browser backend connected', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Verification source').locator('option')).toHaveCount(8);
  await page.getByRole('button', { name: 'Open source browser', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Interact with source browser' })).toBeVisible();
  await page.getByRole('button', { name: 'Interact with source browser' }).click({ position: { x: 30, y: 50 } });
  await expect.poll(() => controls.some(action => action.type === 'click')).toBe(true);
  await page.getByRole('button', { name: 'Use this session', exact: true }).click();
  await expect(page.getByLabel('Use browser session for this source')).toBeChecked();
  await page.screenshot({ path: info.outputPath('browser-verification-mobile.png'), fullPage: true });
  await page.goto('/#/browse');
  await page.getByRole('button', { name: 'Browse MangaHub EN', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Browser Session Hero', exact: true })).toBeVisible();
  expect(sourceRequests.some(url => new URL(url).searchParams.get('browser') === '1')).toBe(true);
  await page.goto('/#/connections?source=4758858684982406533');
  await expect(page.getByLabel('Use browser session for this source')).toBeChecked();
});
test('explains setup when the host has no browser backend', async ({ page }) => {
  await page.context().route('**/api/source-browser?*', route => route.fulfill({ contentType: 'application/json', body: '{"configured":false}' }));
  await page.goto('/#/connections');
  await expect(page.getByText('Browser backend needs setup', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ubuntu VPS setup instructions' })).toHaveAttribute('href', '/help/browser-backend.html');
  await expect(page.getByRole('button', { name: 'Open source browser', exact: true })).toHaveCount(0);
});
test('can restore direct requests after a previously configured browser backend is removed', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mihon-browser-sources', '["4758858684982406533"]'));
  await page.context().route('**/api/source-browser?*', route => route.fulfill({ contentType: 'application/json', body: '{"configured":false}' }));
  await page.goto('/#/connections');
  await expect(page.getByText('Browser backend needs setup', { exact: true })).toBeVisible();
  await page.getByLabel('Use browser session for this source').uncheck();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mihon-browser-sources')!))).toEqual([]);
});
