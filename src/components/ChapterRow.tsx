import { useEffect, useRef } from 'react';
import type { ChapterStateRecord } from '../lib/db';
import type { SChapter } from '../sources/Source';
import DownloadButton from './DownloadButton';
import Icon from './Icon';

type Props = {
  chapter: SChapter; state?: ChapterStateRecord;
  mangaKey: string; sourceId: string; mangaId: string;
  sourceAvailable: boolean; online: boolean;
  selecting: boolean; selected: boolean; busy: boolean;
  onOpen: () => void; onToggle: () => void; onRange: () => void; onOptions: () => void;
};

export default function ChapterRow({ chapter, state, mangaKey, sourceId, mangaId, sourceAvailable, online, selecting, selected, busy, onOpen, onToggle, onRange, onOptions }: Props) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const point = useRef({ x: 0, y: 0 });
  const handled = useRef(false);
  const held = useRef(false);
  const pressing = useRef(false);
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined; };
  const endPress = () => { cancel(); pressing.current = false; };
  useEffect(() => cancel, []);
  const canOpen = chapter.external || state?.downloaded || sourceAvailable && online;
  const date = chapter.dateUpload ? new Date(chapter.dateUpload) : null;
  const details = [chapter.scanlator, !state?.read && state?.lastPage ? `Page ${state.lastPage + 1}` : '', chapter.external ? 'External' : ''].filter(Boolean).join(' · ');

  return <div className={`chapter-row ${state?.read ? 'is-read' : ''} ${selected ? 'selected' : ''}`}>
    <button type="button" className="chapter-open" disabled={busy} aria-disabled={!selecting && !canOpen || undefined}
      aria-label={selecting ? `Select ${chapter.name}` : undefined} aria-pressed={selecting ? selected : undefined}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || busy) return;
        cancel(); handled.current = false; held.current = false; pressing.current = true;
        point.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(() => { handled.current = true; held.current = true; onRange(); }, 450);
      }}
      onPointerMove={event => {
        if (pressing.current && Math.hypot(event.clientX - point.current.x, event.clientY - point.current.y) > 10) { endPress(); handled.current = true; }
      }}
      onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={() => { endPress(); handled.current = true; }}
      onContextMenu={event => { event.preventDefault(); endPress(); if (!busy && !held.current) { held.current = true; onRange(); } handled.current = true; }}
      onClick={event => {
        if (handled.current && event.detail > 0) { handled.current = false; return; }
        handled.current = false;
        if (event.shiftKey) onRange();
        else if (selecting) onToggle();
        else if (canOpen) onOpen();
      }}>
      <span className="chapter-copy">
        <span className="chapter-title">{state?.bookmark && <Icon name="bookmark" size={14} filled />}{chapter.name}</span>
        <span className="chapter-meta">
          <span className="chapter-stamp">
            <span className="chapter-reading-state">{state?.read ? <Icon name="check" size={12} /> : <span className="unread-dot" aria-hidden="true" />}<span className="sr-only">{state?.read ? 'Read' : 'Unread'}</span></span>
            {date ? <time dateTime={date.toISOString()}>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time> : <span>Imported</span>}
          </span>
          {details && <span className="chapter-extra" title={details}>{details}</span>}
        </span>
      </span>
      {selecting && <span className={`chapter-selection-marker ${selected ? 'is-selected' : ''}`} aria-hidden="true">{selected && <Icon name="check" size={15} />}</span>}
    </button>
    {!selecting && <>
      {!chapter.external && (sourceAvailable || state?.downloaded) && <DownloadButton mangaKey={mangaKey} sourceId={sourceId} mangaId={mangaId} chapterId={chapter.id} downloaded={!!state?.downloaded} />}
      <button className="icon-btn" aria-label={`Options for ${chapter.name}`} onClick={onOptions}><Icon name="more" size={18} /></button>
    </>}
  </div>;
}
