import { test, expect, type Page } from '@playwright/test';

// Regression spec for the 2026-11-14 auto-delete report: finished chapters
// stayed downloaded (Max Level Player 99-104, read but still checked) even
// after a manual delete, and survived refreshes and restarts. Two causes:
// (1) deleteChapterDownload enumerated the WHOLE cache (~27k pages at 271
// chapters) before committing the record removal, so iOS suspended the app
// mid-delete and the record stayed; (2) the deferred reader-exit
// auto-delete only runs on a clean exit — a session ended by locking the
// phone or swiping the app away never deletes anything. The fix deletes by
// constructed page URL with the record removal committed first, and runs a
// startup sweep that removes read + downloaded chapters on the next boot.
// This spec covers the sweep: a read chapter seeded as downloaded is gone
// after a reload, while an unread downloaded chapter is untouched.

const SOURCE_ID = '6000000000000000000';
const MANGA_KEY = `${SOURCE_ID}::/sweep-hero`;
const READ_ID = 'chapter-1';
const READ_KEY = `${MANGA_KEY}::${READ_ID}`;
const UNREAD_ID = 'chapter-2';
const UNREAD_KEY = `${MANGA_KEY}::${UNREAD_ID}`;
const PAGE_COUNT = 6;

async function openDb(page: Page): Promise<void> {
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

// Seeds one title with two fully downloaded 6-page chapters: chapter 1 is
// marked read (the killed-session case), chapter 2 is unread.
async function seedChapters(page: Page): Promise<void> {
  await page.evaluate(
    async ({ mangaKey, pageCount, read, unread }) => {
      const svg = (n: number) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#222"/><text x="400" y="600" font-size="64" fill="#fff" text-anchor="middle">Page ${n}</text></svg>`;
      const cache = await caches.open('mihon-pages-v1');
      for (const chapterKey of [read.key, unread.key]) {
        for (let i = 0; i < pageCount; i++) {
          await cache.put(
            `https://cache.mihon.local/${encodeURIComponent(chapterKey)}/${i}`,
            new Response(svg(i + 1), { headers: { 'Content-Type': 'image/svg+xml' } }),
          );
        }
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
              id: '/sweep-hero',
              sourceId: '6000000000000000000',
              title: 'Sweep Hero',
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
          for (const chapter of [read, unread]) {
            tx.objectStore('chapterMeta').put({
              key: chapter.key,
              mangaKey,
              chapter: {
                id: chapter.id,
                mangaId: '/sweep-hero',
                name: chapter.id === read.id ? 'Chapter 1' : 'Chapter 2',
                number: chapter.id === read.id ? 1 : 2,
                dateUpload: 1000,
              },
            });
            tx.objectStore('chapterState').put({
              key: chapter.key,
              mangaKey,
              read: chapter.id === read.id,
              lastPage: 0,
              downloaded: true,
            });
            tx.objectStore('downloads').put({
              key: chapter.key,
              mangaKey,
              pageCount,
              downloadedAt: 30,
              pages: Array.from({ length: pageCount }, () => ({ width: 800, height: 1200 })),
            });
          }
        };
      });
    },
    {
      mangaKey: MANGA_KEY,
      pageCount: PAGE_COUNT,
      read: { id: READ_ID, key: READ_KEY },
      unread: { id: UNREAD_ID, key: UNREAD_KEY },
    },
  );
}

async function readDownload(page: Page, chapterKey: string): Promise<unknown> {
  return page.evaluate(async (key) => {
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
          .get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? null);
      });
    } finally {
      db.close();
    }
  }, chapterKey);
}

async function readChapterState(page: Page, chapterKey: string): Promise<{ read: boolean; downloaded: boolean } | null> {
  return page.evaluate(async (key) => {
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
          .get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result ?? null);
      });
    } finally {
      db.close();
    }
  }, chapterKey);
}

async function cachedPageCount(page: Page, chapterKey: string): Promise<number> {
  return page.evaluate(async (key) => {
    const cache = await caches.open('mihon-pages-v1');
    const prefix = `https://cache.mihon.local/${encodeURIComponent(key)}/`;
    let count = 0;
    for (const request of await cache.keys()) if (request.url.startsWith(prefix)) count++;
    return count;
  }, chapterKey);
}

test('startup sweep deletes the read chapter and keeps the unread one', async ({
  page,
}) => {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({ timeout: 5000 });
  await openDb(page);
  await seedChapters(page);
  expect(await readDownload(page, READ_KEY)).not.toBeNull();
  expect(await readDownload(page, UNREAD_KEY)).not.toBeNull();

  // A fresh boot runs reconcile + the auto-delete sweep.
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({ timeout: 5000 });

  await expect.poll(async () => readDownload(page, READ_KEY), { timeout: 15000 }).toBeNull();
  await expect
    .poll(async () => (await readChapterState(page, READ_KEY))?.downloaded, { timeout: 15000 })
    .toBe(false);
  expect((await readChapterState(page, READ_KEY))?.read).toBe(true);
  await expect.poll(async () => cachedPageCount(page, READ_KEY), { timeout: 15000 }).toBe(0);

  // The unread chapter is untouched: record, flag, and all pages remain.
  expect(await readDownload(page, UNREAD_KEY)).not.toBeNull();
  expect(await readChapterState(page, UNREAD_KEY)).toMatchObject({ read: false, downloaded: true });
  expect(await cachedPageCount(page, UNREAD_KEY)).toBe(PAGE_COUNT);
});
