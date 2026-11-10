import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipIfNeeded } from '../../src/backup/compression';
import { parseTachibk } from '../../src/backup/parser';
// WebKit's service worker can bypass network route fixtures. Online adapter
// tests use direct requests; the separate offline test retains the worker.
test.use({ serviceWorkers: 'block' });

const sources = [
  ['4758858684982406533', 'MangaHub'], ['2528986671771677900', 'Mangakakalot'],
  ['993336618407081332', 'Manhwa18.cc'], ['4841602236575491202', 'Manhwa18.cc (legacy)'],
  ['6247824327199706550', 'Asura Scans'], ['7798162483793432927', 'MangaLife'],
  ['6484561431658238800', 'MangaFox'],
  ['3112384885023225761', 'Kissmanga.in'],
];
async function fixtureRequests(page: Page, blockKiss = false) {
  // <img> requests do not call window.fetch. Serve their synthetic bytes
  // separately from the API fixtures used by the adapter methods.
  await page.context().route('**/api/source?*', async route => {
    if (new URL(route.request().url()).searchParams.has('image')) await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="red"/></svg>' });
    else await route.continue();
  });
  await page.addInitScript(blockKiss => {
    const original = window.fetch.bind(window);
    const image = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="600" fill="blue"/><rect y="600" width="800" height="600" fill="red"/></svg>';
    window.fetch = async (input, init) => {
      const request = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (request.pathname !== '/api/source') return original(input, init);
      if (navigator.onLine === false) throw new TypeError('Offline fixture');
      if (request.searchParams.has('image')) return new Response(image, { headers: { 'Content-Type': 'image/svg+xml' } });
      const source = request.searchParams.get('source'), url = new URL(request.searchParams.get('url')!);
      const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      const html = (value: string) => new Response('<html><body>' + value + '</body></html>', { headers: { 'Content-Type': 'text/html' } });
      if (source === '4758858684982406533') {
        const query = JSON.parse(init?.body as string).query as string;
        if (query.includes('search(')) return json({ data: { search: { rows: [{ slug: 'fixture', title: 'Fixture Hero', image: 'fixture.jpg' }] } } });
        if (query.includes('manga(')) return json({ data: { manga: { slug: 'fixture', title: 'Fixture Hero', image: 'fixture.jpg', genres: 'Action', chapters: [{ number: 1, title: '', date: '2026-01-01' }] } } });
        return json({ data: { chapter: { pages: '["fixture/1.jpg"]' } } });
      }
      if (source === '2528986671771677900') {
        if (url.pathname.includes('/api/manga/')) return json({ success: true, data: { chapters: [{ chapter_slug: 'chapter-1', chapter_name: 'Chapter 1', chapter_num: 1, updated_at: '2026-01-01' }] } });
        if (url.pathname.endsWith('/chapter-1')) return html('<script>const cdns = ["https://img-r1.2xstorage.com/"];const chapterImages = ["fixture/1.jpg"];</script>');
        if (url.pathname === '/manga/fixture') return html('<div class="manga-info-top"><h1>Fixture Hero</h1></div><div class="manga-info-pic"><img src="https://img-r1.2xstorage.com/cover.jpg"></div>');
        return html('<div class="list-truyen-item-wrap"><a href="https://www.kakamanga.com/manga/fixture" title="Fixture Hero"><img src="https://img-r1.2xstorage.com/cover.jpg"></a></div>');
      }
      if (source === '6247824327199706550') {
        if (url.hostname.startsWith('api.')) return json({ data: [{ slug: 'fixture', title: 'Fixture Hero', cover: 'https://cdn.asurascans.com/cover.jpg', public_url: '/comics/fixture-abcdefgh' }] });
        const props = url.pathname.includes('/chapter/') ? { pages: [1, [[0, { url: [0, 'https://cdn.asurascans.com/fixture.jpg'], tiles: [1, [[0, 1], [0, 0]]], tile_cols: [0, 1], tile_rows: [0, 2] }]]] } : { title: [0, 'Fixture Hero'], description: [0, 'Fixture description'], coverUrl: [0, 'https://cdn.asurascans.com/cover.jpg'], publicUrl: [0, '/comics/fixture-abcdefgh'], seriesSlug: [0, 'fixture'], chapters: [1, [[0, { number: [0, 1], title: [0, ''], created_at: [0, '2026-01-01'] }]]] };
        return html(`<astro-island props='${JSON.stringify(props)}'></astro-island>`);
      }
      if (source === '7798162483793432927') {
        if (url.pathname.startsWith('/read-online/')) return html('<script>vm.CurChapter = {"Chapter":"100010","Page":"1"}; vm.CurPathName = "cdn.mangalife.us"; vm.IndexName = "fixture";</script>');
        if (url.pathname === '/manga/fixture') return html('<script>vm.Chapters = [{"Chapter":"100010","Date":"2026-01-01"}];</script>');
        return html('<script>vm.Directory = [{"i":"fixture","s":"Fixture Hero"}]; vm.LatestUpdates = [{"i":"fixture","s":"Fixture Hero"}];</script>');
      }
      if (source === '6484561431658238800') {
        if (url.hostname.startsWith('m.')) return html('<div id="viewer"><img data-original="https://zjcdn.mangafox.me/fixture.jpg"></div>');
        if (url.pathname === '/manga/fixture/') return html('<h1 class="detail-info-right-title-font">Fixture Hero</h1><img class="detail-info-cover-img" src="https://c.mfcdn.net/cover.jpg"><ul class="detail-main-list"><li><a href="/manga/fixture/c001/1.html"><div class="detail-main-list-main"><p>Chapter 1</p><p>Jan 1,2026</p></div></a></li></ul>');
        return html('<ul class="manga-list-1-list manga-list-4-list"><li><a href="/manga/fixture/" title="Fixture Hero"><img src="https://c.mfcdn.net/cover.jpg"></a></li></ul>');
      }
      if (source === '3112384885023225761') {
        if (blockKiss) return new Response(JSON.stringify({ error: 'Kissmanga.in is blocking app requests. Try again later or open the source website.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        if (url.pathname.endsWith('/ajax/chapters/')) return html('<li class="wp-manga-chapter"><a href="https://kissmanga.in/kissmanga/fixture/chapter-1/">Chapter 1</a></li>');
        if (url.pathname.includes('/chapter-1')) return html('<div class="reading-content"><img src="https://kissmanga.in/fixture.jpg"></div>');
        if (url.pathname === '/kissmanga/fixture/') return html('<div class="post-title"><h1>Fixture Hero</h1></div><div class="summary_image"><img src="https://kissmanga.in/cover.jpg"></div>');
        return html('<div class="page-item-detail"><h3><a href="/kissmanga/fixture/">Fixture Hero</a></h3><img src="https://kissmanga.in/cover.jpg"></div>');
      }
      if (url.pathname.includes('/chapter-')) return html('<div class="read-content"><img data-src="https://manhwa18.cc/fixture/1.jpg"></div>');
      if (url.pathname === '/webtoon/fixture') return html('<div class="post-title"><h1>Fixture Hero</h1></div><div class="summary_image"><img src="https://manhwa18.cc/cover.jpg"></div><ul class="row-content-chapter"><li><a href="/webtoon/fixture/chapter-1">Chapter 1</a><span class="chapter-time">01 Jan 2026</span></li></ul>');
      return html('<div class="page-item-detail"><h3><a href="/webtoon/fixture">Fixture Hero</a></h3><img src="https://manhwa18.cc/cover.jpg"></div>');
    };
  }, blockKiss);
}
for (const [id, name] of sources) {
  test(`browses ${name}, loads chapters and reads its built-in pages without Suwayomi`, async ({ page }) => {
    await fixtureRequests(page);
    await page.goto('/#/browse');
    await page.getByRole('button', { name: `Browse ${name} EN`, exact: true }).click();
    await page.getByRole('button', { name: 'Open Fixture Hero', exact: true }).click();
    await expect(page.locator('.chapter-open').filter({ hasText: 'Chapter 1' })).toBeVisible();
    await page.getByRole('button', { name: /Start reading/ }).click();
    await expect.poll(() => page.locator('.reader-page img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mihon-settings') ?? '{}').suwayomiUrl ?? '')).toBe('');
    if (id === '6247824327199706550') {
      expect(await page.locator('.reader-page img').first().evaluate(image => {
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext('2d')!; context.drawImage(image as HTMLImageElement, 0, 0);
        return [...context.getImageData(0,0,1,1).data];
      })).toEqual([255,0,0,255]);
    }
  });
}
test('shows only backup sources by default and explains a source access block', async ({ page }) => {
  await fixtureRequests(page, true);
  await page.goto('/#/browse');
  await expect(page.locator('.source-browse-row')).toHaveCount(9);
  await expect.poll(() => page.locator('.source-browse-row .source-logo img').evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length)).toBe(9);
  await expect(page.getByRole('button', { name: /Browse.*Demo/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse Kissmanga.in EN', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('blocking app requests');
  await expect(page.getByRole('link', { name: 'Open source website', exact: true })).toHaveAttribute('href','https://kissmanga.in');
});
async function seedMigration(page: Page) {
  await page.goto('/#/browse');
  await expect(page.locator('.source-browse-row')).toHaveCount(9);
  const key = '4758858684982406533::/manga/old-fixture';
  await page.evaluate(async key => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('mihon-pwa'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction(['manga', 'chapterMeta', 'chapterState', 'history', 'library'], 'readwrite');
    tx.objectStore('manga').put({ key, manga: { id: '/manga/old-fixture', sourceId: '4758858684982406533', sourceName: 'MangaHub', title: 'Fixture Hero', description: '', genres: [], status: 'Ongoing', coverUrl: '' }, updatedAt: 1, sourceAvailable: true });
    const chapterKey = key + '::/old-fixture/chapter-1.0';
    tx.objectStore('chapterMeta').put({ key: chapterKey, mangaKey: key, chapter: { id: '/old-fixture/chapter-1.0', mangaId: '/manga/old-fixture', name: 'Chapter 1', number: 1, dateUpload: 0 } });
    tx.objectStore('chapterState').put({ key: chapterKey, mangaKey: key, read: true, bookmark: true, lastPage: 7, downloaded: false, lastReadAt: 1794000000000 });
    tx.objectStore('history').put({ key: chapterKey, mangaKey: key, mangaTitle: 'Fixture Hero', coverUrl: '', chapterName: 'Chapter 1', page: 7, updatedAt: 1794000000000, readDuration: 45000 });
    tx.objectStore('library').put({ key, category: 'Reading', categories: ['Reading', 'On Hold'], addedAt: 100 });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  }, key);
  return key;
}
test('migrates MangaHub to Mangakakalot and retains progress, categories, history and Android identity', async ({ page }) => {
  await fixtureRequests(page);
  await page.context().route('**/api/proxy?*', route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Fixture unavailable"}' }));
  const original = await seedMigration(page);
  await page.goto('/#/migrate?' + new URLSearchParams({ manga: original }));
  await expect(page.getByLabel('Search replacement title')).toHaveValue('Fixture Hero');
  await expect(page.getByLabel('Replacement source')).toHaveValue('6247824327199706550');
  await page.getByLabel('Replacement source').selectOption('2528986671771677900');
  await page.getByRole('button', { name: 'Open Fixture Hero', exact: true }).click();
  await expect(page.getByText('1 chapters available · 1 / 1 chapters with progress matched')).toBeVisible();
  await page.getByRole('button', { name: 'Migrate to this title', exact: true }).click();
  await expect(page.locator('.manga-source')).toContainText('Mangakakalot');
  const records = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('mihon-pwa'); request.onsuccess = () => resolve(request.result); });
    const get = (store: string) => new Promise<any[]>(resolve => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); });
    const result = { library: await get('library'), states: await get('chapterState'), history: await get('history') }; db.close(); return result;
  });
  expect(records.library).toHaveLength(1);
  expect(records.library[0]).toMatchObject({ categories: ['Reading', 'On Hold'], addedAt: 100 });
  expect(records.states.find(state => state.mangaKey === records.library[0].key)).toMatchObject({ read: true, bookmark: true, lastPage: 7 });
  expect(records.history.find(row => row.mangaKey === records.library[0].key)).toMatchObject({ page: 7, readDuration: 45000 });
  await page.goto('/#/backup');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for Mihon Android (.tachibk)', exact: true }).click();
  const exported = parseTachibk(await gunzipIfNeeded(new Uint8Array(await readFile((await (await pending).path())!))));
  expect(exported.manga.find(manga => manga.favorite)).toMatchObject({ source: 2528986671771677900n, url: 'https://www.kakamanga.com/manga/fixture' });
  expect(exported.manga.find(manga => manga.favorite)?.chapters[0]).toMatchObject({ read: true, bookmark: true, lastPageRead: 7 });
});
test('migrates a MangaHub title to the default Asura source after chapter review', async ({ page }) => {
  await fixtureRequests(page);
  const original = await seedMigration(page);
  await page.goto('/#/migrate?' + new URLSearchParams({ manga: original }));
  await expect(page.getByLabel('Replacement source')).toHaveValue('6247824327199706550');
  await page.getByRole('button', { name: 'Open Fixture Hero', exact: true }).click();
  await expect(page.locator('.migration-review')).toContainText('Asura Scans');
  await expect(page.getByText('1 chapters available · 1 / 1 chapters with progress matched')).toBeVisible();
  await page.getByRole('button', { name: 'Migrate to this title', exact: true }).click();
  await expect(page.locator('.manga-source')).toContainText('Asura Scans');
  await expect(page.locator('.chapter-row.is-read .chapter-reading-state')).toHaveText('Read');
});
test('discards an old replacement search when the user changes sources', async ({ page }) => {
  await fixtureRequests(page);
  let release!: () => void;
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.context().route('**/api/proxy?*', async route => { started(); await held; await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Delayed old source error"}' }); });
  const original = await seedMigration(page);
  await page.goto('/#/migrate?' + new URLSearchParams({ manga: original }));
  await page.getByLabel('Replacement source').selectOption('mangadex');
  await requested;
  await page.getByLabel('Replacement source').selectOption('2528986671771677900');
  await expect(page.getByRole('button', { name: 'Open Fixture Hero', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Fixture Hero', exact: true }).click();
  await expect(page.locator('.migration-review')).toContainText('Mangakakalot');
  await page.getByLabel('Replacement source').selectOption('4758858684982406533');
  await expect(page.locator('.migration-review')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Fixture Hero', exact: true }).click();
  await expect(page.locator('.migration-review')).toContainText('MangaHub');
});
test.describe('built-in offline reading', () => {
test.use({ serviceWorkers: 'allow' });
test('downloads and cold-reloads a built-in chapter offline without a server connection', async ({ page, context }) => {
  await fixtureRequests(page);
  await page.goto('/#/browse');
  await page.getByRole('button', { name: 'Browse MangaHub EN', exact: true }).click();
  await page.getByRole('button', { name: 'Open Fixture Hero', exact: true }).click();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('button', { name: /Next 5 unread chapters/ }).click();
  await expect(page.getByText('1 chapters available offline')).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('button', { name: /Start reading/ }).click();
  await expect.poll(() => page.locator('.reader-page img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect.poll(() => page.locator('.reader-page img').evaluateAll(images => images.some(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
});
});
