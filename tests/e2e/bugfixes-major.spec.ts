import { test, expect, type Page } from '@playwright/test';
import { schemaFile } from '../fixtures/mihon';

// Regression specs for the 4 MAJOR findings fixed 2026-11-13 (findings 1
// and 2 need a real browser: the reader's scroll-back recycling and the
// Library snapshot's restore invalidation are not unit-testable).
// Findings 3 and 4 are covered by unit tests (clearQueue.test.ts,
// syncQuarantine.test.ts).

const SOURCE_ID = '6000000000000000000';
const MANGA_KEY = `${SOURCE_ID}::/autodel-hero`;
const CHAPTER_ID = 'chapter-1';
const CHAPTER_KEY = `${MANGA_KEY}::${CHAPTER_ID}`;
const PAGE_COUNT = 6;

async function openDb(page: Page): Promise<void> {
  // Proves the app initialized mihon-pwa before seeding (same guard as
  // the fast-scroller spec: onupgradeneeded means the app never ran).
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('mihon-pwa');
        request.onerror = () => reject(request.error ?? new Error('Could not open mihon-pwa'));
        request.onupgradeneeded = () => {
          request.transaction?.abort();
          reject(new Error('The app must initialize mihon-pwa before seeding'));
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
      }),
  );
}

// Seeds one title with a fully downloaded 6-page chapter: manga + library
// + chapterMeta + chapterState rows, a downloads record, and the pages
// themselves in the mihon-pages-v1 Cache Storage namespace the reader
// reads (pageCacheKey: https://cache.mihon.local/<chapterKey>/<index>).
async function seedDownloadedChapter(page: Page): Promise<void> {
  await page.evaluate(
    async ({ mangaKey, chapterId, chapterKey, pageCount }) => {
      const svg = (n: number) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#222"/><text x="400" y="600" font-size="64" fill="#fff" text-anchor="middle">Page ${n}</text></svg>`;
      const cache = await caches.open('mihon-pages-v1');
      for (let i = 0; i < pageCount; i++) {
        await cache.put(
          `https://cache.mihon.local/${encodeURIComponent(chapterKey)}/${i}`,
          new Response(svg(i + 1), { headers: { 'Content-Type': 'image/svg+xml' } }),
        );
      }
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('mihon-pwa');
        request.onerror = () => reject(request.error ?? new Error('Could not open mihon-pwa'));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(
            ['manga', 'library', 'chapterMeta', 'chapterState', 'downloads'],
            'readwrite',
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error('Fixture transaction aborted'));
          };
          tx.objectStore('manga').put({
            key: mangaKey,
            manga: {
              id: '/autodel-hero',
              sourceId: '6000000000000000000',
              title: 'Autodel Hero',
              coverUrl: '',
              genres: [],
              description: '',
              status: 'Ongoing',
            },
            updatedAt: 10,
          });
          tx.objectStore('library').put({
            key: mangaKey,
            category: 'Default',
            categories: ['Default'],
            addedAt: 20,
          });
          tx.objectStore('chapterMeta').put({
            key: chapterKey,
            mangaKey,
            chapter: {
              id: chapterId,
              mangaId: '/autodel-hero',
              name: 'Chapter 1',
              number: 1,
              dateUpload: 1000,
            },
          });
          tx.objectStore('chapterState').put({
            key: chapterKey,
            mangaKey,
            read: false,
            lastPage: 0,
            downloaded: true,
          });
          tx.objectStore('downloads').put({
            key: chapterKey,
            mangaKey,
            pageCount,
            downloadedAt: 30,
            pages: Array.from({ length: pageCount }, () => ({ width: 800, height: 1200 })),
          });
        };
      });
    },
    { mangaKey: MANGA_KEY, chapterId: CHAPTER_ID, chapterKey: CHAPTER_KEY, pageCount: PAGE_COUNT },
  );
}

async function readDownload(page: Page): Promise<unknown> {
  return page.evaluate(async (chapterKey) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mihon-pwa');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction('downloads', 'readonly')
          .objectStore('downloads')
          .get(chapterKey);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? null);
      });
    } finally {
      db.close();
    }
  }, CHAPTER_KEY);
}

async function readChapterState(page: Page): Promise<{ read: boolean; downloaded: boolean } | null> {
  return page.evaluate(async (chapterKey) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mihon-pwa');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction('chapterState', 'readonly')
          .objectStore('chapterState')
          .get(chapterKey);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? null);
      });
    } finally {
      db.close();
    }
  }, CHAPTER_KEY);
}

async function scrollReaderTo(page: Page, top: number): Promise<void> {
  await page.evaluate((value) => {
    const screen = document.querySelector('.reader-screen');
    if (!screen) throw new Error('No .reader-screen');
    screen.scrollTo({ top: value, behavior: 'auto' });
  }, top);
}

async function readerScrollHeight(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.reader-screen')?.scrollHeight ?? 0);
}

test('finding 1: finished downloaded chapter keeps its pages while reading, deletes on exit', async ({
  page,
}) => {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Your library starts here')).toBeVisible({ timeout: 5000 });
  await openDb(page);
  await seedDownloadedChapter(page);

  await page.goto(
    '/#/reader?' + new URLSearchParams({ manga: MANGA_KEY, chapter: CHAPTER_ID }),
  );
  // First page loads from the cache.
  await expect
    .poll(
      async () =>
        page.locator('.reader-page img').evaluateAll((images) =>
          images.some(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      { timeout: 10000 },
    )
    .toBe(true);

  // Read to the end: scroll to the bottom of the strip and wait for the
  // progress flush to mark the chapter read.
  const height = await readerScrollHeight(page);
  expect(height).toBeGreaterThan(1000);
  await scrollReaderTo(page, height);
  await expect
    .poll(async () => (await readChapterState(page))?.read, { timeout: 10000 })
    .toBe(true);

  // The download must STILL be there while the reader shows the chapter
  // (the old code deleted it on the finishing flush).
  expect(await readDownload(page)).not.toBeNull();

  // Scroll back to the top: recycled pages re-read the cache and must
  // load — no "Page N could not load" errors.
  await scrollReaderTo(page, 0);
  await expect
    .poll(
      async () =>
        page.locator('.reader-page img').evaluateAll((images) =>
          images.some(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await expect(page.locator('.page-error')).toHaveCount(0);

  // Leaving the reader runs the deferred auto-delete.
  await page.keyboard.press('Escape');
  await expect(page.locator('h1', { hasText: 'Autodel Hero' })).toBeVisible({
    timeout: 5000,
  });
  await expect.poll(async () => readDownload(page), { timeout: 10000 }).toBeNull();
  await expect
    .poll(async () => (await readChapterState(page))?.downloaded, { timeout: 10000 })
    .toBe(false);
});

test('finding 2: restoring a backup refreshes the Library without a manual refresh', async ({
  page,
}) => {
  // Load the Library FIRST so the (empty) session snapshot exists — the
  // bug was that a restore never invalidated an already-loaded snapshot.
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Your library starts here')).toBeVisible({ timeout: 5000 });

  await page.goto('/#/backup');
  await page
    .getByLabel('Choose backup file')
    .setInputFiles({
      name: 'schema-fixture.tachibk',
      mimeType: 'application/gzip',
      buffer: Buffer.from(await schemaFile().arrayBuffer()),
    });
  await expect(page.getByRole('heading', { name: 'Review Mihon backup' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore 2 library titles' }).click();
  await expect(page.getByRole('heading', { name: '2 titles restored' })).toBeVisible();

  // No refresh tap: the Library must already show the restored titles.
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Schema Hero' })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByRole('button', { name: 'Open MangaDex fixture' })).toBeVisible({
    timeout: 10000,
  });
});
