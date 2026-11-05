import { useEffect, useRef, useState } from "react";
import {
  MangaGrid,
  MangaList,
  type MangaListItem,
} from "../components/MangaViews";
import {
  getChapterMetas,
  getChapterStates,
  getLibrary,
  getManga,
  patchChapterState,
  putChapterMetas,
  removeFromLibrary,
  setLibraryCategory,
} from "../lib/db";
import { useNav } from "../lib/nav";
import {
  loadSettings,
  onSettingsChange,
  saveSettings,
} from "../lib/settings";
import { useLoad } from "../lib/useLoad";
import { CATEGORIES } from "../sources/Source";
import { getSource } from "../sources";

async function loadLibrary() {
  const entries = await getLibrary();
  const items = await Promise.all(
    entries.map(async (entry) => {
      const stored = await getManga(entry.key);
      if (!stored) return null;

      const source = getSource(stored.manga.sourceId);
      let metas = await getChapterMetas(entry.key);

      if (metas.length === 0 && source && stored.sourceAvailable) {
        const chapters = await source.getChapterList(stored.manga.id);
        await putChapterMetas(source.id, stored.manga.id, chapters);
        metas = await getChapterMetas(entry.key);
      }

      const states = await getChapterStates(entry.key);
      const readKeys = new Set(
        states.filter((state) => state.read).map((state) => state.key),
      );
      const unread = metas.filter(
        (meta) => !meta.chapter.external && !readKeys.has(meta.key),
      ).length;

      return { entry, stored, unread };
    }),
  );

  return items.filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function LibraryPage() {
  const { openManga } = useNav();
  const { data, loading, error, reload } = useLoad(loadLibrary, []);
  const [view, setView] = useState(() => loadSettings().libraryView);
  const [category, setCategory] = useState<string>("All");
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionInProgress = useRef(false);

  useEffect(() => {
    const syncSettings = () => setView(loadSettings().libraryView);
    const unsubscribe = onSettingsChange(syncSettings);
    syncSettings();
    return unsubscribe;
  }, []);

  const libraryItems = data ?? [];
  // Built-in categories plus any extra category names present in the
  // library (e.g. categories created by a Mihon backup import).
  const extraCategories = [
    ...new Set(libraryItems.map((item) => item.entry.category)),
  ].filter((c) => !(CATEGORIES as readonly string[]).includes(c));
  const tabCategories: string[] = ["All", ...CATEGORIES, ...extraCategories];
  const visibleItems = libraryItems
    .filter((item) => category === "All" || item.entry.category === category)
    .sort((a, b) => a.stored.manga.title.localeCompare(b.stored.manga.title));

  const mangaItems: MangaListItem[] = visibleItems.map(
    ({ entry, stored, unread }) => ({
      key: entry.key,
      manga: stored.manga,
      unread,
      sourceMissing:
        !stored.sourceAvailable || !getSource(stored.manga.sourceId),
    }),
  );

  const menuItem = libraryItems.find((item) => item.entry.key === menuKey);
  const menuVisible = menuItem !== undefined;

  useEffect(() => {
    if (!menuVisible) return;

    const previousFocus = document.activeElement;
    menuRef.current?.focus();

    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [menuKey, menuVisible]);

  function toggleView() {
    const next = view === "grid" ? "list" : "grid";
    saveSettings({ libraryView: next });
    setView(loadSettings().libraryView);
  }

  function openMenu(key: string) {
    if (actionInProgress.current) return;
    setMenuError(null);
    setMenuKey(key);
  }

  function closeMenu() {
    if (actionInProgress.current) return;
    setMenuKey(null);
    setMenuError(null);
  }

  async function runMenuAction(action: () => Promise<unknown>) {
    if (actionInProgress.current) return;

    actionInProgress.current = true;
    setMenuBusy(true);
    setMenuError(null);

    try {
      await action();
      await reload();
      setMenuKey(null);
    } catch (cause: unknown) {
      setMenuError(errorMessage(cause));
    } finally {
      actionInProgress.current = false;
      setMenuBusy(false);
    }
  }

  return (
    <div className="screen">
      <header
        className="topbar"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h1>Library</h1>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={toggleView}
          aria-label={`Switch to ${view === "grid" ? "list" : "grid"} view`}
          title={`Switch to ${view === "grid" ? "list" : "grid"} view`}
        >
          {view === "grid" ? "☰" : "▦"}
        </button>
      </header>

      <div
        role="group"
        aria-label="Library category"
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          padding: "8px 0 16px",
        }}
      >
        {tabCategories.map((cat) => (
          <button
            key={cat}
            type="button"
            className="chip"
            aria-pressed={category === cat}
            onClick={() => setCategory(cat)}
            style={{
              flexShrink: 0,
              whiteSpace: "nowrap",
              ...(category === cat
                ? {
                    background: "var(--accent, #6366f1)",
                    borderColor: "var(--accent, #6366f1)",
                    color: "var(--bg, #fff)",
                  }
                : {}),
            }}
          >
            {cat}
          </button>
        ))}
      </div>

      {loading ? (
        <div role="status" aria-label="Loading library">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : error ? (
        <div className="error" role="alert">
          <p>{errorMessage(error)}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void reload();
            }}
          >
            Retry
          </button>
        </div>
      ) : libraryItems.length === 0 ? (
        <div className="empty">
          Your library is empty. Find manga in Browse.
        </div>
      ) : mangaItems.length === 0 ? (
        <div className="empty">Nothing in this category.</div>
      ) : view === "grid" ? (
        <MangaGrid
          items={mangaItems}
          onOpen={openManga}
          onMenu={openMenu}
        />
      ) : (
        <MangaList
          items={mangaItems}
          onOpen={openManga}
          onMenu={openMenu}
        />
      )}

      {menuItem && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeMenu();
          }}
        >
          <div
            ref={menuRef}
            className="menu-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-menu-title"
            aria-busy={menuBusy}
            tabIndex={-1}
            style={{
              width: "100%",
              maxWidth: 480,
              maxHeight: "85dvh",
              overflowY: "auto",
              padding: 16,
              boxSizing: "border-box",
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
                return;
              }

              if (event.key !== "Tab") return;

              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              const first = buttons[0];
              const last = buttons[buttons.length - 1];

              if (!first || !last) {
                event.preventDefault();
                event.currentTarget.focus();
                return;
              }

              const active = document.activeElement;
              const activeIsButton = buttons.some((button) => button === active);

              if (event.shiftKey && (active === first || !activeIsButton)) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && (active === last || !activeIsButton)) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <h2 id="library-menu-title" style={{ marginTop: 0 }}>
              {menuItem.stored.manga.title}
            </h2>

            {menuError && (
              <p className="error" role="alert">
                {menuError}
              </p>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {CATEGORIES.map((cat) => {
                const current = menuItem.entry.category === cat;

                return (
                  <button
                    key={cat}
                    type="button"
                    className="btn"
                    disabled={menuBusy || current}
                    onClick={() => {
                      void runMenuAction(() =>
                        setLibraryCategory(menuItem.entry.key, cat),
                      );
                    }}
                  >
                    Move to {cat}
                    {current ? " ✓" : ""}
                  </button>
                );
              })}

              <button
                type="button"
                className="btn"
                disabled={menuBusy}
                onClick={() => {
                  void runMenuAction(async () => {
                    const key = menuItem.entry.key;
                    const metas = await getChapterMetas(key);
                    await Promise.all(
                      metas.map((meta) =>
                        patchChapterState(meta.key, key, { read: true }),
                      ),
                    );
                  });
                }}
              >
                Mark all read
              </button>

              <button
                type="button"
                className="btn btn-danger"
                disabled={menuBusy}
                onClick={() => {
                  void runMenuAction(() =>
                    removeFromLibrary(menuItem.entry.key),
                  );
                }}
              >
                Remove from Library
              </button>

              <button
                type="button"
                className="btn btn-ghost"
                disabled={menuBusy}
                onClick={closeMenu}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
