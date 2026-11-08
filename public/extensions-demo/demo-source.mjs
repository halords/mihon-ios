// Demo extension for the Mihon PWA extension system.
//
// A plugin is a single self-contained ES module: no imports. It exports
// `source` (or a default export) implementing the Source interface from
// src/sources/Source.ts. The host app hands modules an API object at
// globalThis.MihonHost (fetchJson / fetchText / proxiedUrl / key helpers) —
// see PLUGIN.md. This demo needs no network: covers and pages are generated
// SVG data URIs, like the built-in sample source.

const SOURCE_ID = 'demo-extension';

function svgUri(svg) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function cover(title, hue) {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="680">` +
      `<rect width="480" height="680" fill="hsl(${hue},45%,22%)"/>` +
      `<rect x="24" y="24" width="432" height="632" fill="none" stroke="hsl(${hue},70%,65%)" stroke-width="3"/>` +
      `<text x="240" y="330" font-family="sans-serif" font-size="40" fill="#fff" text-anchor="middle">${title}</text>` +
      `<text x="240" y="380" font-family="sans-serif" font-size="20" fill="hsl(${hue},70%,75%)" text-anchor="middle">via extension</text>` +
      `</svg>`,
  );
}

function page(title, chapter, pageNum, hue) {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200">` +
      `<rect width="800" height="1200" fill="hsl(${hue},30%,92%)"/>` +
      `<text x="400" y="120" font-family="sans-serif" font-size="34" fill="#222" text-anchor="middle">${title}</text>` +
      `<text x="400" y="600" font-family="sans-serif" font-size="28" fill="#444" text-anchor="middle">Chapter ${chapter} — Page ${pageNum}</text>` +
      `<text x="400" y="660" font-family="sans-serif" font-size="20" fill="#666" text-anchor="middle">Served by the demo extension plugin.</text>` +
      `</svg>`,
  );
}

const TITLES = [
  { id: 'ember-sea', title: 'Ember Sea', hue: 18, chapters: 6, status: 'Ongoing' },
  { id: 'paper-moon-diner', title: 'Paper Moon Diner', hue: 210, chapters: 4, status: 'Ongoing' },
  { id: 'the-long-static', title: 'The Long Static', hue: 265, chapters: 5, status: 'Completed' },
];

const DAY = 86_400_000;
const EPOCH = 1_760_000_000_000;

function toManga(t) {
  return {
    id: t.id,
    sourceId: SOURCE_ID,
    title: t.title,
    author: 'Extension Demo',
    status: t.status,
    description: `${t.title} is served entirely by an installed extension plugin, ` +
      'proving the source pipeline (browse, details, chapters, reader) works ' +
      'for modules that were never compiled into the app.',
    genres: ['Demo'],
    coverUrl: cover(t.title, t.hue),
  };
}

function toChapter(t, n) {
  return {
    id: `${t.id}-ch-${n}`,
    mangaId: t.id,
    name: `Chapter ${n}`,
    number: n,
    dateUpload: EPOCH + n * DAY,
  };
}

function findTitle(id) {
  return TITLES.find((t) => t.id === id);
}

export const source = {
  id: SOURCE_ID,
  name: 'Demo Extension',

  async getPopularManga() {
    return TITLES.map(toManga);
  },

  async getLatestUpdates() {
    return [...TITLES].reverse().map(toManga);
  },

  async searchManga(query) {
    const q = query.trim().toLowerCase();
    return TITLES.filter((t) => t.title.toLowerCase().includes(q)).map(toManga);
  },

  async getMangaDetails(id) {
    const t = findTitle(id);
    if (!t) throw new Error(`Unknown demo title: ${id}`);
    return toManga(t);
  },

  async getChapterList(mangaId) {
    const t = findTitle(mangaId);
    if (!t) throw new Error(`Unknown demo title: ${mangaId}`);
    return Array.from({ length: t.chapters }, (_, i) => toChapter(t, i + 1));
  },

  async getPageList(chapterId) {
    const match = /^(.+)-ch-(\d+)$/.exec(chapterId);
    if (!match) throw new Error(`Unknown demo chapter: ${chapterId}`);
    const t = findTitle(match[1]);
    if (!t) throw new Error(`Unknown demo title: ${match[1]}`);
    const chapter = Number(match[2]);
    return [1, 2, 3].map((p) => ({
      imageUrl: page(t.title, chapter, p, t.hue),
    }));
  },
};
