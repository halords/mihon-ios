// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  FAST_SCROLLER_ACTIVATION_PX,
  FAST_SCROLLER_COLLAPSE_MS,
  FAST_SCROLLER_MIN_THUMB_PX,
  scrollTopForThumb,
  shouldActivateScroller,
  thumbMetrics,
} from '../src/lib/fastScroller';

describe('fast scroller constants', () => {
  it('exports the activation, collapse, and minimum thumb values', () => {
    expect(FAST_SCROLLER_ACTIVATION_PX).toBe(24);
    expect(FAST_SCROLLER_COLLAPSE_MS).toBe(1000);
    expect(FAST_SCROLLER_MIN_THUMB_PX).toBe(40);
  });
});

describe('thumbMetrics', () => {
  const base = {
    scrollTop: 0,
    scrollHeight: 4000,
    clientHeight: 800,
    trackHeight: 800,
  };

  it('returns null when the page is not scrollable', () => {
    expect(thumbMetrics({ ...base, scrollHeight: 800 })).toBeNull();
    expect(thumbMetrics({ ...base, scrollHeight: 400 })).toBeNull();
    expect(
      thumbMetrics({ ...base, scrollHeight: 0, clientHeight: 0 }),
    ).toBeNull();
  });

  it('returns null when the track has no usable height', () => {
    expect(thumbMetrics({ ...base, trackHeight: 0 })).toBeNull();
    expect(thumbMetrics({ ...base, trackHeight: -1 })).toBeNull();
  });

  it('calculates proportional height and starts at the track top', () => {
    expect(thumbMetrics(base)).toEqual({
      top: 0,
      height: 160,
      maxScroll: 3200,
    });
  });

  it('applies the minimum thumb height', () => {
    expect(
      thumbMetrics({
        ...base,
        clientHeight: 100,
        scrollHeight: 100000,
      }),
    ).toEqual({
      top: 0,
      height: 40,
      maxScroll: 99900,
    });
  });

  it('supports a custom minimum and clamps height to the track', () => {
    expect(thumbMetrics({ ...base, minThumbPx: 200 })?.height).toBe(200);
    expect(thumbMetrics({ ...base, trackHeight: 20 })).toEqual({
      top: 0,
      height: 20,
      maxScroll: 3200,
    });
    expect(thumbMetrics({ ...base, minThumbPx: 1000 })?.height).toBe(800);
  });

  it('places the thumb at the end of its travel at maximum scroll', () => {
    expect(thumbMetrics({ ...base, scrollTop: 3200 })).toEqual({
      top: 640,
      height: 160,
      maxScroll: 3200,
    });
  });

  it('maps mid-scroll proportionally', () => {
    expect(thumbMetrics({ ...base, scrollTop: 1600 })?.top).toBe(320);
  });

  it('clamps overscroll at both ends', () => {
    expect(thumbMetrics({ ...base, scrollTop: -100 })?.top).toBe(0);
    expect(thumbMetrics({ ...base, scrollTop: 5000 })?.top).toBe(640);
  });
});

describe('scrollTopForThumb', () => {
  const base = {
    clientY: 100,
    trackTop: 100,
    trackHeight: 800,
    thumbHeight: 160,
    maxScroll: 3200,
  };

  it('maps the track top to zero', () => {
    expect(scrollTopForThumb(base)).toBe(0);
  });

  it('maps the bottom of thumb travel and track bottom to maximum scroll', () => {
    expect(scrollTopForThumb({ ...base, clientY: 740 })).toBe(3200);
    expect(scrollTopForThumb({ ...base, clientY: 900 })).toBe(3200);
  });

  it('maps mid-track travel proportionally', () => {
    expect(scrollTopForThumb({ ...base, clientY: 420 })).toBe(1600);
  });

  it('honors the grab offset', () => {
    expect(
      scrollTopForThumb({ ...base, clientY: 460, grabOffset: 40 }),
    ).toBe(1600);
    expect(
      scrollTopForThumb({ ...base, clientY: 140, grabOffset: 40 }),
    ).toBe(0);
  });

  it('clamps pointer positions beyond both ends', () => {
    expect(scrollTopForThumb({ ...base, clientY: -100 })).toBe(0);
    expect(scrollTopForThumb({ ...base, clientY: 2000 })).toBe(3200);
  });

  it('avoids division by zero when there is no thumb travel', () => {
    expect(
      scrollTopForThumb({
        ...base,
        thumbHeight: 800,
        clientY: 100,
      }),
    ).toBe(0);
    expect(
      scrollTopForThumb({
        ...base,
        thumbHeight: 800,
        clientY: 101,
      }),
    ).toBe(3200);
  });
});

describe('shouldActivateScroller', () => {
  it('activates only at or beyond 24px', () => {
    expect(shouldActivateScroller(0)).toBe(false);
    expect(shouldActivateScroller(23)).toBe(false);
    expect(shouldActivateScroller(24)).toBe(true);
    expect(shouldActivateScroller(100)).toBe(true);
  });
});
