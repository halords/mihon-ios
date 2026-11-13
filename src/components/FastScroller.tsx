import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  FAST_SCROLLER_COLLAPSE_MS,
  FAST_SCROLLER_MIN_THUMB_PX,
  scrollTopForThumb,
  shouldActivateScroller,
  thumbMetrics,
} from '../lib/fastScroller';

type FastScrollerProps = {
  bottomOffset?: string;
  hidden?: boolean;
};

const DEFAULT_BOTTOM_OFFSET =
  'calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px) + 12px)';

export default function FastScroller({
  bottomOffset = DEFAULT_BOTTOM_OFFSET,
  hidden = false,
}: FastScrollerProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const hitRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const metricsRef = useRef<ReturnType<typeof thumbMetrics>>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const grabOffsetRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const visibleRef = useRef(false);
  const expandedRef = useRef(false);

  const changeVisible = useCallback((next: boolean) => {
    if (visibleRef.current !== next) {
      visibleRef.current = next;
      setVisible(next);
    }
  }, []);

  const changeExpanded = useCallback((next: boolean) => {
    if (expandedRef.current !== next) {
      expandedRef.current = next;
      setExpanded(next);
    }
  }, []);

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  const restartCollapseTimer = useCallback(() => {
    clearCollapseTimer();
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      if (mountedRef.current && !draggingRef.current) {
        changeExpanded(false);
      }
    }, FAST_SCROLLER_COLLAPSE_MS);
  }, [changeExpanded, clearCollapseTimer]);

  const update = useCallback(() => {
    const track = trackRef.current;
    const hit = hitRef.current;

    if (!track || !hit) {
      return;
    }

    const root = document.documentElement;
    const trackRect = track.getBoundingClientRect();
    const metrics = thumbMetrics({
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      trackHeight: trackRect.height,
    });

    metricsRef.current = metrics;

    if (metrics) {
      // Position the hit area, not just its inner visual bar.
      hit.style.height = `${metrics.height}px`;
      hit.style.transform = `translateY(${metrics.top}px)`;
      // Allow the proportional thumb to fit even in a track shorter than 40px.
      hit.style.minHeight = `${Math.min(
        FAST_SCROLLER_MIN_THUMB_PX,
        metrics.height,
      )}px`;
    }

    changeVisible(
      metrics !== null && shouldActivateScroller(root.scrollTop) && !hidden,
    );
  }, [changeVisible, hidden]);

  const scheduleUpdate = useCallback(() => {
    if (!mountedRef.current || rafRef.current !== null) {
      return;
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      if (mountedRef.current) {
        update();
      }
    });
  }, [update]);

  useEffect(() => {
    mountedRef.current = true;
    changeExpanded(false);
    update();

    const hit = hitRef.current;

    const onScroll = () => {
      if (!draggingRef.current) {
        changeExpanded(true);
        restartCollapseTimer();
      }
      scheduleUpdate();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleUpdate);

    observer?.observe(document.documentElement);
    // Also catch content growth when the root's own box is viewport-sized.
    if (document.body) {
      observer?.observe(document.body);
    }
    if (trackRef.current) {
      observer?.observe(trackRef.current);
    }

    return () => {
      mountedRef.current = false;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', scheduleUpdate);
      observer?.disconnect();
      clearCollapseTimer();

      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      const pointerId = pointerIdRef.current;
      pointerIdRef.current = null;
      draggingRef.current = false;
      metricsRef.current = null;

      if (
        hit &&
        pointerId !== null &&
        hit.hasPointerCapture(pointerId)
      ) {
        hit.releasePointerCapture(pointerId);
      }
    };
  }, [
    bottomOffset,
    changeExpanded,
    clearCollapseTimer,
    restartCollapseTimer,
    scheduleUpdate,
    update,
  ]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        hidden ||
        draggingRef.current
      ) {
        return;
      }

      update();

      const thumb = thumbRef.current;
      if (!thumb || !visibleRef.current || !metricsRef.current) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      pointerIdRef.current = event.pointerId;
      draggingRef.current = true;
      grabOffsetRef.current = event.clientY - thumb.getBoundingClientRect().top;

      clearCollapseTimer();
      changeExpanded(true);
    },
    [changeExpanded, clearCollapseTimer, hidden, update],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        !draggingRef.current ||
        pointerIdRef.current !== event.pointerId ||
        hidden
      ) {
        return;
      }

      event.preventDefault();

      const track = trackRef.current;
      const metrics = metricsRef.current;
      if (!track || !metrics) {
        return;
      }

      const trackRect = track.getBoundingClientRect();
      if (trackRect.height <= 0) {
        return;
      }

      const top = scrollTopForThumb({
        clientY: event.clientY,
        trackTop: trackRect.top,
        trackHeight: trackRect.height,
        thumbHeight: metrics.height,
        maxScroll: metrics.maxScroll,
        grabOffset: grabOffsetRef.current,
      });

      window.scrollTo({ top, behavior: 'auto' });
      scheduleUpdate();
    },
    [hidden, scheduleUpdate],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        !draggingRef.current ||
        pointerIdRef.current !== event.pointerId
      ) {
        return;
      }

      draggingRef.current = false;
      pointerIdRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (mountedRef.current) {
        restartCollapseTimer();
        scheduleUpdate();
      }
    },
    [restartCollapseTimer, scheduleUpdate],
  );

  const isVisible = visible && !hidden;
  const style: CSSProperties & { '--fast-scroller-bottom': string } = {
    '--fast-scroller-bottom': bottomOffset,
  };

  return (
    <div
      ref={trackRef}
      className={[
        'fast-scroller',
        expanded ? 'is-expanded' : '',
        !isVisible ? 'is-hidden' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      aria-hidden="true"
      data-testid="fast-scroller"
      data-expanded={expanded ? 'true' : 'false'}
      data-visible={isVisible ? 'true' : 'false'}
    >
      <div
        ref={hitRef}
        className="fast-scroller-hit"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      >
        <div
          ref={thumbRef}
          className="fast-scroller-thumb"
          aria-hidden="true"
          data-testid="fast-scroller-thumb"
        />
      </div>
    </div>
  );
}
