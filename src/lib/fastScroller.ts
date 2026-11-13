export const FAST_SCROLLER_ACTIVATION_PX = 24;
export const FAST_SCROLLER_COLLAPSE_MS = 1000;
export const FAST_SCROLLER_MIN_THUMB_PX = 40;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function thumbMetrics(input: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  trackHeight: number;
  minThumbPx?: number;
}): { top: number; height: number; maxScroll: number } | null {
  const {
    scrollTop,
    scrollHeight,
    clientHeight,
    trackHeight,
    minThumbPx = FAST_SCROLLER_MIN_THUMB_PX,
  } = input;

  const maxScroll = scrollHeight - clientHeight;

  if (maxScroll <= 0 || trackHeight <= 0) {
    return null;
  }

  const height = Math.min(
    trackHeight,
    Math.max(minThumbPx, (trackHeight * clientHeight) / scrollHeight),
  );
  const travel = trackHeight - height;
  const top = clamp((scrollTop / maxScroll) * travel, 0, travel);

  return { top, height, maxScroll };
}

export function scrollTopForThumb(input: {
  clientY: number;
  trackTop: number;
  trackHeight: number;
  thumbHeight: number;
  maxScroll: number;
  grabOffset?: number;
}): number {
  const {
    clientY,
    trackTop,
    trackHeight,
    thumbHeight,
    maxScroll,
    grabOffset = 0,
  } = input;

  const fraction = clamp(
    (clientY - trackTop - grabOffset) /
      Math.max(trackHeight - thumbHeight, 1),
    0,
    1,
  );

  return fraction * maxScroll;
}

export function shouldActivateScroller(scrollTop: number): boolean {
  return scrollTop >= FAST_SCROLLER_ACTIVATION_PX;
}
