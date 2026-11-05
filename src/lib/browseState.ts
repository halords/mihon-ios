import type { SManga } from '../sources/Source';

/**
 * Snapshot of the Browse tab so leaving and coming back (opening a manga,
 * switching tabs, reloading within the session) restores the search query,
 * results and scroll position instead of starting over — like a native
 * app. Held in module memory for instant restore and mirrored to
 * sessionStorage so it also survives a page reload within the session.
 */
export interface BrowseState {
  query: string; // the debounced (trimmed) query the items belong to
  mode: 'popular' | 'latest';
  items: SManga[];
  scrollY: number;
}

const STORAGE_KEY = 'mihon:browse-state-v1';

let memory: BrowseState | null = null;

function isBrowseState(value: unknown): value is BrowseState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.query === 'string' &&
    (record.mode === 'popular' || record.mode === 'latest') &&
    Array.isArray(record.items) &&
    typeof record.scrollY === 'number'
  );
}

export function loadBrowseState(): BrowseState | null {
  if (memory) {
    return memory;
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isBrowseState(parsed)) {
        memory = parsed;
        return memory;
      }
    }
  } catch {
    // sessionStorage unavailable or corrupt — start fresh.
  }
  return null;
}

export function saveBrowseState(state: BrowseState): void {
  memory = state;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage unavailable — module memory still holds it.
  }
}
