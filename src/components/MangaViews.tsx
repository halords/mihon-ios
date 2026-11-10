import { useEffect, useRef } from 'react';
import type { SManga } from '../sources/Source';
import Cover from './Cover';
import Icon from './Icon';

export interface MangaListItem {
  key: string; manga: SManga; unread?: number; downloaded?: number;
  sourceMissing?: boolean; inLibrary?: boolean; selected?: boolean;
}
type Props = { items: MangaListItem[]; onOpen: (key: string) => void; onMenu?: (key: string) => void };
function usePress(key: string, open: Props['onOpen'], menu?: Props['onMenu']) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const point = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => cancel, []);
  return {
    onPointerDown(event: React.PointerEvent) {
      if (!menu || event.button !== 0) return;
      fired.current = false;
      point.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => { fired.current = true; menu(key); }, 450);
    },
    onPointerMove(event: React.PointerEvent) { if (Math.hypot(event.clientX - point.current.x, event.clientY - point.current.y) > 10) cancel(); },
    onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel,
    onContextMenu(event: React.MouseEvent) { if (menu) { event.preventDefault(); cancel(); menu(key); fired.current = true; } },
    onClick() { if (fired.current) fired.current = false; else open(key); },
  };
}
function MangaItem({ item, onOpen, onMenu, list = false }: { item: MangaListItem; list?: boolean } & Omit<Props, 'items'>) {
  const press = usePress(item.key, onOpen, onMenu);
  return <button type="button" className={`manga-pressable ${list ? 'manga-list-item' : 'manga-card'} ${item.selected ? 'selected' : ''}`} aria-label={`Open ${item.manga.title}`} aria-pressed={item.selected} {...press}>
    <span className="manga-art">
      <Cover url={item.manga.coverUrl} title={item.manga.title} />
      {!list && <span className="manga-gradient" />}
      {!list && <span className="manga-badges">
        {!!item.unread && <span className="badge" aria-label={`${item.unread} unread chapters`}>{item.unread}</span>}
        {!!item.downloaded && <span className="badge badge-download" aria-label={`${item.downloaded} downloaded chapters`}><Icon name="download" size={11} />{item.downloaded}</span>}
        {item.inLibrary && <span className="badge badge-library" aria-label="In library"><Icon name="heart" size={12} filled /></span>}
      </span>}
      {item.selected && <span className="selection-check"><Icon name="check" size={18} /></span>}
    </span>
    <span className="manga-caption"><span className="manga-title">{item.manga.title}</span>
      {list && <span className="manga-subtitle">{item.manga.sourceName || item.manga.author || item.manga.status}</span>}
      {item.sourceMissing && <span className="source-missing">Connect source</span>}
    </span>
    {list && <span className="list-badges">{!!item.unread && <span className="badge">{item.unread}</span>}{!!item.downloaded && <span className="badge badge-download"><Icon name="download" size={12} />{item.downloaded}</span>}</span>}
  </button>;
}
export function MangaGrid({ items, ...props }: Props) { return <div className="manga-grid">{items.map(item => <MangaItem key={item.key} item={item} {...props} />)}</div>; }
export function MangaList({ items, ...props }: Props) { return <div className="manga-list">{items.map(item => <MangaItem key={item.key} item={item} list {...props} />)}</div>; }
export function HeartIconSvg({ filled, size = 11 }: { filled: boolean; size?: number }) { return <Icon name="heart" filled={filled} size={size} />; }
