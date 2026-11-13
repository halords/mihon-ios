import { test, expect, type Page } from '@playwright/test';

type Fixture = 'library' | 'details';

async function seedFixture(page: Page, fixture: Fixture): Promise<void> {
  await page.evaluate(
    (kind) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('mihon-pwa');

        request.onerror = () => {
          reject(request.error ?? new Error('Could not open mihon-pwa'));
        };

        request.onupgradeneeded = () => {
          request.transaction?.abort();
          reject(new Error('The app must initialize mihon-pwa before seeding'));
        };

        request.onsuccess = () => {
          const db = request.result;

          try {
            const transaction = db.transaction(
              ['manga', 'library', 'chapterMeta'],
              'readwrite',
            );
            const mangaStore = transaction.objectStore('manga');
            const libraryStore = transaction.objectStore('library');
            const chapterStore = transaction.objectStore('chapterMeta');

            transaction.oncomplete = () => {
              db.close();
              resolve();
            };

            transaction.onabort = () => {
              db.close();
              reject(
                transaction.error ?? new Error('Fixture transaction aborted'),
              );
            };

            if (kind === 'library') {
              for (let i = 0; i < 60; i += 1) {
                const key = `6000000000000000000::seed-title-${i}`;

                mangaStore.put({
                  key,
                  manga: {
                    id: `seed-title-${i}`,
                    sourceId: '6000000000000000000',
                    title: `Seed Title ${i}`,
                    coverUrl: '',
                    genres: [],
                    description: '',
                    status: 'Ongoing',
                  },
                  updatedAt: 10,
                });

                libraryStore.put({
                  key,
                  category: 'Default',
                  categories: ['Default'],
                  addedAt: 20 + i,
                });
              }
            } else {
              const key = '6000000000000000000::seed-long';

              mangaStore.put({
                key,
                manga: {
                  id: 'seed-long',
                  sourceId: '6000000000000000000',
                  title: 'Seed Long',
                  coverUrl: '',
                  genres: [],
                  description: '',
                  status: 'Ongoing',
                },
                updatedAt: 10,
              });

              libraryStore.put({
                key,
                category: 'Default',
                categories: ['Default'],
                addedAt: 20,
              });

              for (let n = 1; n <= 200; n += 1) {
                chapterStore.put({
                  key: `${key}::chapter-${n}`,
                  mangaKey: key,
                  chapter: {
                    id: `chapter-${n}`,
                    mangaId: 'seed-long',
                    name: `Chapter ${n}`,
                    number: n,
                    dateUpload: 1000 + n,
                  },
                });
              }
            }
          } catch (error) {
            db.close();
            reject(error);
          }
        };
      }),
    fixture,
  );
}

async function checkScroller(page: Page): Promise<void> {
  const track = page.getByTestId('fast-scroller');

  await expect(track).toBeAttached({ timeout: 5000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.documentElement.scrollHeight -
            document.documentElement.clientHeight,
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThan(1600);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }));
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 })
    .toBe(0);
  await expect(track).toHaveAttribute('data-visible', 'false', {
    timeout: 5000,
  });

  // Programmatic scrolling avoids mobile WebKit wheel inconsistencies while
  // still exercising the real window scroll listener.
  await page.evaluate(() => window.scrollTo({ top: 800, behavior: 'auto' }));

  // WebKit delivers the scroll event + rAF noticeably later than Chromium
  // (~200ms observed); 300ms was marginal under parallel load.
  await expect(track).toHaveAttribute('data-visible', 'true', {
    timeout: 2000,
  });
  await expect(track).toHaveAttribute('data-expanded', 'true', {
    timeout: 2000,
  });

  await page.waitForTimeout(1300);

  await expect(track).toHaveAttribute('data-expanded', 'false', {
    timeout: 5000,
  });
  await expect(track).toHaveAttribute('data-visible', 'true', {
    timeout: 5000,
  });

  const initialScrollY = await page.evaluate(() => window.scrollY);
  const box = await page.getByTestId('fast-scroller-thumb').boundingBox();

  expect(box).not.toBeNull();
  if (!box) {
    throw new Error('The fast scroller thumb has no bounding box');
  }

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await expect(track).toHaveAttribute('data-expanded', 'true', {
    timeout: 2000,
  });
  await page.mouse.move(centerX, centerY + 200, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 })
    .toBeGreaterThan(initialScrollY + 400);
}

test('Library fast scroller activates, collapses, and scrubs the window', async ({
  page,
}) => {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({
    timeout: 5000,
  });
  // The empty state proves the first library load ran, so mihon-pwa exists.
  await expect(page.getByText('Your library starts here')).toBeVisible({
    timeout: 5000,
  });

  await seedFixture(page, 'library');
  await page.reload();

  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByText(/^Seed Title \d+$/).first()).toBeVisible({
    timeout: 5000,
  });

  await checkScroller(page);
});

test('Chapter-list fast scroller activates, collapses, and scrubs the window', async ({
  page,
}) => {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: /^Library/ })).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByText('Your library starts here')).toBeVisible({
    timeout: 5000,
  });

  await seedFixture(page, 'details');

  const query = new URLSearchParams({
    manga: '6000000000000000000::seed-long',
  });
  await page.goto('/#/details?' + query.toString());

  await expect(page.getByText(/^Chapter \d+$/).first()).toBeVisible({
    timeout: 5000,
  });

  await checkScroller(page);
});
