import { downloadRemovalKey, getDB, getRawDB } from './db';
import { cancelMangaDownloadJobs } from './downloadQueue';
import { deleteMangaDownloads } from './downloads';

export async function purgeMangaFiles(mangaKey: string): Promise<void> {
  await cancelMangaDownloadJobs(mangaKey);
  await deleteMangaDownloads(mangaKey);
  const db = await getDB();
  const manga = await db.get('manga', mangaKey);
  const cover = manga?.manga.coverUrl;
  if (cover && !/^(data:|blob:)/.test(cover) && typeof caches !== 'undefined') {
    const library = await db.getAll('library');
    const titles = await Promise.all(library.map(entry => db.get('manga', entry.key)));
    if (!titles.some(title => title?.manga.coverUrl === cover)) {
      await (await caches.open('mihon-covers-v1')).delete('https://cache.mihon.local/cover/' + encodeURIComponent(cover));
    }
  }
  const tx = db.transaction(['metadata', 'library'], 'readwrite');
  if (!await tx.objectStore('library').get(mangaKey) && await tx.objectStore('metadata').get(downloadRemovalKey(mangaKey))) {
    await tx.objectStore('metadata').put({ key: downloadRemovalKey(mangaKey), value: { pending: false } });
  }
  await tx.done;
}

// A reload or interrupted cleanup must not leave large files orphaned.
export async function resumeLibraryFileCleanup(): Promise<void> {
  const db = await getRawDB();
  for (const record of await db.getAll('metadata')) {
    if (!record.key.startsWith('downloads:removed:') || !(record.value as { pending?: boolean } | null)?.pending) continue;
    const key = record.key.slice('downloads:removed:'.length);
    if (!await db.get('library', key)) await purgeMangaFiles(key);
  }
}
