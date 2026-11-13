import { test, expect, type Page } from '@playwright/test';

// Regression specs for MINOR findings 7 and 9: failed last-page
// completion and the capped eager window when resuming in webtoon mode.

const SOURCE_ID = '6000000000000000001';
const MANGA_KEY = `${SOURCE_ID}::/minor-hero`;
const CHAPTER_ID = 'chapter-1';
const CHAPTER_KEY = `${MANGA_KEY}::${CHAPTER_ID}`;

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

// Seeds one title with a fully downloaded chapter: manga + library
// + chapterMeta + chapterState rows, a downloads record, and the pages
// themselves in the mihon-pages-v1 Cache Storage namespace the reader
// reads (pageCacheKey: https://cache.mihon.local/<chapterKey>/<index>).
async function seedDownloadedChapter(
  page: Page,
  { pageCount, lastPage, withDimensions }: {
    pageCount: number;
    lastPage: number;
    withDimensions: boolean;
  },
): Promise<void> {
  await page.evaluate(
    async ({ mangaKey, chapterId, chapterKey, pageCount, lastPage, withDimensions }) => {
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
              id: '/minor-hero',
              sourceId: '6000000000000000001',
              title: 'Minor Hero',
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
              mangaId: '/minor-hero',
              name: 'Chapter 1',
              number: 1,
              dateUpload: 1000,
            },
          });
          tx.objectStore('chapterState').put({
            key: chapterKey,
            mangaKey,
            read: false,
            lastPage,
            downloaded: true,
          });
          tx.objectStore('downloads').put({
            key: chapterKey,
            mangaKey,
            pageCount,
            downloadedAt: 30,
            pages: Array.from(
              { length: pageCount },
              () => withDimensions ? { width: 800, height: 1200 } : {},
            ),
          });
        };
      });
    },
    {
      mangaKey: MANGA_KEY,
      chapterId: CHAPTER_ID,
      chapterKey: CHAPTER_KEY,
      pageCount,
      lastPage,
      withDimensions,
    },
  );
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

test('finding 7: a chapter whose last page fails to load is still marked read at the end', async ({
  page,
}) => {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Your library starts here')).toBeVisible({ timeout: 10000 });
  await openDb(page);
  await seedDownloadedChapter(page, { pageCount: 6, lastPage: 0, withDimensions: true });

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

  // Keep every page cached until the reader recognizes the download.
  // The last page is still outside the activation observer's margin;
  // deleting it now makes its activation fail after scrolling.
  await page.evaluate(async (chapterKey) => {
    await (await caches.open('mihon-pages-v1')).delete(
      'https://cache.mihon.local/' + encodeURIComponent(chapterKey) + '/5',
    );
  }, CHAPTER_KEY);

  const height = await readerScrollHeight(page);
  expect(height).toBeGreaterThan(1000);
  await scrollReaderTo(page, height);
  await expect
    .poll(async () => (await readChapterState(page))?.read, { timeout: 10000 })
    .toBe(true);

  // Prove the failure happened, rather than passing on a loaded last page.
  await expect
    .poll(async () => page.locator('.page-error').count(), { timeout: 10000 })
    .toBe(1);
});

test('finding 9: resuming deep into a chapter mounts only a small eager window', async ({
  page,
}) => {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Your library starts here')).toBeVisible({ timeout: 10000 });
  await openDb(page);
  // Dimension-less downloaded pages exercise eager-forced activation.
  await seedDownloadedChapter(page, { pageCount: 30, lastPage: 25, withDimensions: false });

  await page.goto(
    '/#/reader?' + new URLSearchParams({ manga: MANGA_KEY, chapter: CHAPTER_ID }),
  );
  await expect
    .poll(
      async () =>
        page.evaluate(() => document.querySelector('.reader-screen')?.scrollTop ?? 0),
      { timeout: 10000 },
    )
    .toBeGreaterThan(1000);

  // Only the first three pages and ±2 around the resume target are eager.
  await expect
    .poll(
      async () =>
        page.locator('img[loading="eager"]').evaluateAll((images) =>
          [...new Set(images.map((image) =>
            Number(image.closest('[data-page]')?.getAttribute('data-page')),
          ))].sort((a, b) => a - b),
        ),
      { timeout: 10000 },
    )
    .toEqual([0, 1, 2, 23, 24, 25, 26, 27]);

  await expect
    .poll(async () => page.locator('.reader-page').count(), { timeout: 10000 })
    .toBe(30);
});
