import type { Source, SManga, SChapter, MangaPage } from './Source';
import { coverArt, pageArt } from './svgArt';

const SOURCE_ID = 'sample';
const FEED_STORAGE_KEY = 'mihon-sample-feed-v1';
const DAY_MS = 86_400_000;
const INITIALIZED_AT = Date.now();

interface SampleChapter {
  number: number;
  name: string;
  pages: number;
  daysAgo: number;
  dateUpload: number;
}

interface SampleManga {
  id: string;
  title: string;
  author: string;
  artist: string;
  status: SManga['status'];
  description: string;
  genres: string[];
  hue: number;
  chapters: SampleChapter[];
}

function makeChapter(
  number: number,
  name: string,
  pages: number,
  daysAgo: number,
): SampleChapter {
  return {
    number,
    name,
    pages,
    daysAgo,
    dateUpload: INITIALIZED_AT - daysAgo * DAY_MS,
  };
}

const mangaTable: SampleManga[] = [
  {
    id: 'starfall-blade',
    title: 'Starfall Blade',
    author: 'A. Kurogane',
    artist: 'A. Kurogane',
    status: 'Ongoing',
    description:
      'When a fallen star shatters the gates of his mountain village, a young smith discovers a blade that remembers its former wielders. To protect his home, he must master their forgotten techniques before the darkness beyond the gates awakens.',
    genres: ['Action', 'Fantasy', 'Martial Arts'],
    hue: 210,
    chapters: [
      makeChapter(1, 'The Fallen Star', 12, 28),
      makeChapter(2, 'Ashes of the Gate', 13, 14),
      makeChapter(3, 'A Blade Reforged', 14, 7),
      makeChapter(4, 'The Hollow Gate', 12, 0),
    ],
  },
  {
    id: 'paper-crane-cafe',
    title: 'Paper Crane Café',
    author: 'M. Hoshino',
    artist: 'M. Hoshino',
    status: 'Completed',
    description:
      'At a quiet café tucked beside the last tram stop, customers leave their wishes inside folded paper cranes. A reserved barista and a wandering illustrator begin answering those wishes, finding the courage to share their own along the way.',
    genres: ['Slice of Life', 'Romance', 'Drama'],
    hue: 18,
    chapters: [
      makeChapter(1, 'Folded Mornings', 9, 65),
      makeChapter(2, 'A Cup for Two', 10, 58),
      makeChapter(3, 'The Last Crane', 8, 51),
    ],
  },
  {
    id: 'deep-signal',
    title: 'Deep Signal',
    author: 'R. Voss',
    artist: 'R. Voss',
    status: 'Ongoing',
    description:
      'An isolated ocean research station receives a transmission from a vessel that vanished decades ago. As its crew decodes the signal, they discover that the next message describes events that have not happened yet.',
    genres: ['Sci-Fi', 'Mystery', 'Thriller'],
    hue: 265,
    chapters: [
      makeChapter(1, 'Echo in the Static', 12, 21),
      makeChapter(2, 'Voices Below', 12, 11),
      makeChapter(3, 'The Silent Array', 12, 2),
    ],
  },
  {
    id: 'iron-bloom',
    title: 'Iron Bloom',
    author: 'S. Adeyemi',
    artist: 'S. Adeyemi',
    status: 'On Hold',
    description:
      'In a kingdom where forests have turned to metal, an apprentice gardener finds the first living seed in a century. Joined by a wandering guardian, she crosses the rustlands to seek the forge that can restore the seasons.',
    genres: ['Fantasy', 'Adventure'],
    hue: 335,
    chapters: [
      makeChapter(1, 'A Seed of Steel', 11, 90),
      makeChapter(2, 'Roots Beyond the Wall', 11, 75),
      makeChapter(3, 'The Sleeping Forge', 11, 60),
    ],
  },
];

function readFeedFlag(): boolean {
  try {
    return localStorage.getItem(FEED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let fourthChapterRevealed = readFeedFlag();

function sleep(): Promise<void> {
  const milliseconds = 60 + Math.floor(Math.random() * 61);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toSManga(manga: SampleManga): SManga {
  return {
    id: manga.id,
    sourceId: SOURCE_ID,
    title: manga.title,
    author: manga.author,
    artist: manga.artist,
    status: manga.status,
    description: manga.description,
    genres: [...manga.genres],
    coverUrl: coverArt(manga.title, manga.author, manga.hue),
  };
}

function findManga(id: string): SampleManga {
  const manga = mangaTable.find((entry) => entry.id === id);
  if (!manga) {
    throw new Error('Manga not found');
  }
  return manga;
}

function visibleChapters(manga: SampleManga): SampleChapter[] {
  return manga.chapters.filter(
    (chapter) =>
      manga.id !== 'starfall-blade' ||
      chapter.number !== 4 ||
      fourthChapterRevealed,
  );
}

function newestUpload(manga: SampleManga): number {
  return Math.max(
    ...visibleChapters(manga).map((chapter) => chapter.dateUpload),
  );
}

export const sampleSource: Source = {
  id: SOURCE_ID,
  name: 'Sample Source (bundled)',

  async getPopularManga(page: number): Promise<SManga[]> {
    await sleep();
    return page === 1 ? mangaTable.map(toSManga) : [];
  },

  async getLatestUpdates(page: number): Promise<SManga[]> {
    await sleep();

    // Simulate the publisher releasing Starfall Blade ch. 4: after the
    // latest-updates feed is checked once, it exists in chapter lists.
    fourthChapterRevealed = true;
    try {
      localStorage.setItem(FEED_STORAGE_KEY, '1');
    } catch {
      // Keep the reveal active for this session if storage is unavailable.
    }

    if (page !== 1) {
      return [];
    }

    return [...mangaTable]
      .sort((a, b) => newestUpload(b) - newestUpload(a))
      .map(toSManga);
  },

  async searchManga(query: string, page: number): Promise<SManga[]> {
    await sleep();
    if (page !== 1) {
      return [];
    }

    const normalizedQuery = query.toLowerCase();
    return mangaTable
      .filter(
        (manga) =>
          manga.title.toLowerCase().includes(normalizedQuery) ||
          manga.genres.some((genre) =>
            genre.toLowerCase().includes(normalizedQuery),
          ),
      )
      .map(toSManga);
  },

  async getMangaDetails(id: string): Promise<SManga> {
    await sleep();
    return toSManga(findManga(id));
  },

  async getChapterList(mangaId: string): Promise<SChapter[]> {
    await sleep();
    const manga = findManga(mangaId);

    return visibleChapters(manga)
      .sort((a, b) => a.number - b.number)
      .map((chapter) => ({
        id: `${manga.id}--${chapter.number}`,
        mangaId: manga.id,
        name: chapter.name,
        number: chapter.number,
        dateUpload: chapter.dateUpload,
      }));
  },

  async getPageList(chapterId: string): Promise<MangaPage[]> {
    await sleep();

    const separator = chapterId.lastIndexOf('--');
    if (separator < 1) {
      throw new Error('Chapter not found');
    }

    const mangaId = chapterId.slice(0, separator);
    const chapterNumber = Number(chapterId.slice(separator + 2));
    const manga = mangaTable.find((entry) => entry.id === mangaId);
    const chapter = manga
      ? visibleChapters(manga).find(
          (entry) => entry.number === chapterNumber,
        )
      : undefined;

    if (!manga || !chapter) {
      throw new Error('Chapter not found');
    }

    return Array.from({ length: chapter.pages }, (_, index) => ({
      imageUrl: pageArt({
        title: manga.title,
        chapterName: chapter.name,
        page: index + 1,
        total: chapter.pages,
        hue: manga.hue,
      }),
    }));
  },
};
