import type { CSSProperties } from "react";
import type { SManga } from "../sources/Source";

export interface MangaListItem {
  key: string;
  manga: SManga;
  unread?: number;
  sourceMissing?: boolean;
}

type MangaViewProps = {
  items: MangaListItem[];
  onOpen: (key: string) => void;
  onMenu?: (key: string) => void;
};

const openButtonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: 0,
  border: 0,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

const titleStyle: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
  overflowWrap: "anywhere",
  fontWeight: 600,
};

const menuButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  borderRadius: "50%",
  flexShrink: 0,
  fontSize: 22,
  lineHeight: 1,
};

function coverUrl(manga: SManga): string | undefined {
  if ("thumbnailUrl" in manga && typeof manga.thumbnailUrl === "string") {
    return manga.thumbnailUrl || undefined;
  }
  if ("coverUrl" in manga && typeof manga.coverUrl === "string") {
    return manga.coverUrl || undefined;
  }
  if ("thumbnail" in manga && typeof manga.thumbnail === "string") {
    return manga.thumbnail || undefined;
  }
  if ("cover" in manga && typeof manga.cover === "string") {
    return manga.cover || undefined;
  }
  return undefined;
}

function NoSourceChip() {
  return (
    <span
      className="chip"
      style={{
        display: "inline-block",
        marginTop: 4,
        padding: "2px 6px",
        fontSize: "0.7rem",
        opacity: 0.65,
      }}
    >
      No source
    </span>
  );
}

export function MangaGrid({ items, onOpen, onMenu }: MangaViewProps) {
  return (
    <div className="grid">
      {items.map((item) => (
        <div
          key={item.key}
          className="card"
          style={{ position: "relative", overflow: "hidden" }}
        >
          <button
            type="button"
            className="btn-ghost"
            style={openButtonStyle}
            onClick={() => onOpen(item.key)}
            aria-label={`Open ${item.manga.title}`}
          >
            <span style={{ display: "block", position: "relative" }}>
              <img
                className="cover"
                src={coverUrl(item.manga)}
                alt=""
                loading="lazy"
                decoding="async"
                style={{
                  display: "block",
                  width: "100%",
                  aspectRatio: "2 / 3",
                  objectFit: "cover",
                }}
              />
              {item.unread !== undefined && item.unread > 0 && (
                <span
                  className="badge"
                  style={{ position: "absolute", top: 6, right: 6 }}
                  aria-label={`${item.unread} unread chapters`}
                >
                  {item.unread}
                </span>
              )}
            </span>
            <span style={{ display: "block", padding: 8 }}>
              <span style={titleStyle}>{item.manga.title}</span>
              {item.sourceMissing && <NoSourceChip />}
              {item.manga.author && (
                <span
                  style={{
                    display: "block",
                    marginTop: 4,
                    fontSize: "0.8rem",
                    opacity: 0.65,
                  }}
                >
                  {item.manga.author}
                </span>
              )}
            </span>
          </button>
          {onMenu && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{
                ...menuButtonStyle,
                position: "absolute",
                top: 6,
                left: 6,
                background: "rgba(0, 0, 0, 0.55)",
                color: "#fff",
              }}
              aria-label={`Options for ${item.manga.title}`}
              aria-haspopup="dialog"
              onClick={(event) => {
                event.stopPropagation();
                onMenu(item.key);
              }}
            >
              ⋮
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function MangaList({ items, onOpen, onMenu }: MangaViewProps) {
  return (
    <div>
      {items.map((item) => (
        <div
          key={item.key}
          className="list-row"
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          <button
            type="button"
            className="btn-ghost"
            style={{
              ...openButtonStyle,
              display: "flex",
              alignItems: "center",
              gap: 12,
              flex: 1,
              minWidth: 0,
            }}
            onClick={() => onOpen(item.key)}
            aria-label={`Open ${item.manga.title}`}
          >
            <img
              className="cover"
              src={coverUrl(item.manga)}
              alt=""
              loading="lazy"
              decoding="async"
              style={{
                display: "block",
                width: 48,
                height: 72,
                flexShrink: 0,
                objectFit: "cover",
              }}
            />
            <span style={{ display: "block", flex: 1, minWidth: 0 }}>
              <span style={titleStyle}>{item.manga.title}</span>
              <span
                style={{
                  display: "block",
                  marginTop: 4,
                  fontSize: "0.8rem",
                  opacity: 0.65,
                }}
              >
                {[item.manga.author, item.manga.status]
                  .filter((value) => value !== undefined && value !== null && value !== "")
                  .join(" · ")}
              </span>
              {item.sourceMissing && <NoSourceChip />}
            </span>
            {item.unread !== undefined && item.unread > 0 && (
              <span
                className="badge"
                style={{ position: "static", flexShrink: 0 }}
                aria-label={`${item.unread} unread chapters`}
              >
                {item.unread}
              </span>
            )}
          </button>
          {onMenu && (
            <button
              type="button"
              className="btn btn-ghost"
              style={menuButtonStyle}
              aria-label={`Options for ${item.manga.title}`}
              aria-haspopup="dialog"
              onClick={(event) => {
                event.stopPropagation();
                onMenu(item.key);
              }}
            >
              ⋮
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
