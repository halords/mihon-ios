import type { HistoryRecord } from './db';

// Live library updates (2026-11-12): local user actions that must show up
// in the Library view immediately, without a manual refresh and without
// any backend traffic. The open-time sync is the only thing that talks to
// the server; these events only patch the in-memory session snapshot.
//
// Emitted ONLY by local action sites:
// - chapter-progress: the reader, after each progress save (read or not).
//   Carries the saved history record so the snapshot's last-read time and
//   continue-reading card stay current, plus whether the chapter became
//   read and whether its download was auto-deleted. The reader saves
//   progress the moment a chapter loads (flush on load), so this is also
//   the move-to-top signal: a title jumps to the top only when one of its
//   chapters is opened AND loaded. Merely opening the details page emits
//   nothing (user correction, 2026-11-12).
// - library-added / library-removed: the details page, after the library
//   entry is written.
// Sync pulls deliberately NEVER emit these: background sync must not
// reshuffle the visible Library (session-snapshot rule, 2026-11-10).
export type LibraryLiveUpdate =
  | { type: 'chapter-progress'; mangaKey: string; chapterKey: string; history: HistoryRecord; read: boolean; downloadedDeleted: boolean }
  | { type: 'library-added'; mangaKey: string }
  | { type: 'library-removed'; mangaKey: string };

const listeners = new Set<(update: LibraryLiveUpdate) => void>();

export function subscribeLibraryLive(fn: (update: LibraryLiveUpdate) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emitLibraryLive(update: LibraryLiveUpdate): void {
  for (const fn of [...listeners]) fn(update);
}
