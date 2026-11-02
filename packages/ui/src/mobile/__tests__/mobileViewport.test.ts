import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { READABLE_FONT_PX, MIN_FONT_PX, fitFontSize, rowsThatFit, planSwipe } from '../MobileXterm.tsx';
import { useVisualViewport } from '../useVisualViewport.ts';

afterEach(() => vi.unstubAllGlobals());

function fakeViewport(height: number, offsetTop = 0) {
  const listeners = new Set<() => void>();
  const vv = {
    height,
    offsetTop,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    fire(next: { height: number; offsetTop?: number }) {
      vv.height = next.height;
      vv.offsetTop = next.offsetTop ?? 0;
      for (const fn of listeners) fn();
    },
    listeners,
  };
  return vv;
}

describe('useVisualViewport', () => {
  it('follows the visible area so the input bar stays above the soft keyboard', () => {
    const vv = fakeViewport(800);
    vi.stubGlobal('visualViewport', vv);
    const { result, unmount } = renderHook(() => useVisualViewport());
    expect(result.current).toEqual({ height: 800, offsetTop: 0 });
    act(() => vv.fire({ height: 480, offsetTop: 12 }));
    expect(result.current).toEqual({ height: 480, offsetTop: 12 });
    unmount();
    expect(vv.listeners.size).toBe(0);
  });

  it('returns null where the browser has no visualViewport', () => {
    vi.stubGlobal('visualViewport', undefined);
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current).toBeNull();
  });
});

describe('fitFontSize floor', () => {
  it('stops at the readable floor when zoomed, so wide grids scroll instead', () => {
    expect(fitFontSize(360, 120, 0.6, 14)).toBe(MIN_FONT_PX);
    expect(fitFontSize(360, 120, 0.6, 14, READABLE_FONT_PX)).toBe(READABLE_FONT_PX);
    // A grid that already fits is not enlarged past the user's font size.
    expect(fitFontSize(1000, 40, 0.6, 14, READABLE_FONT_PX)).toBe(14);
  });
});

describe('terminal pane geometry', () => {
  it('fits as many rows as the pane height holds, never fewer than the floor', () => {
    expect(rowsThatFit(600, 13)).toBe(46);
    expect(rowsThatFit(100, 13)).toBe(10);
    expect(rowsThatFit(0, 13)).toBe(10);
    expect(rowsThatFit(600, 0)).toBeNull();
  });

  // delta > 0: finger moved up, toward newer output.
  const state = (over = {}) => ({ paneTop: 0, paneMax: 0, linesUp: 100, linesDown: 0, cellHeight: 10, ...over });

  it('turns a finger drag into whole scrolled lines, down = back in history, carrying the remainder', () => {
    expect(planSwipe(-35, state())).toEqual({ paneTop: 0, lines: -3, leftover: -5 });
    expect(planSwipe(35, state({ linesDown: 10 }))).toEqual({ paneTop: 0, lines: 3, leftover: 5 });
    expect(planSwipe(-50, state({ cellHeight: 0 }))).toEqual({ paneTop: 0, lines: 0, leftover: 0 });
  });

  it('reveals the top rows of a terminal taller than the pane before going into history', () => {
    expect(planSwipe(-150, state({ paneTop: 200, paneMax: 200 }))).toEqual({ paneTop: 50, lines: 0, leftover: 0 });
    expect(planSwipe(-260, state({ paneTop: 200, paneMax: 200 }))).toEqual({ paneTop: 0, lines: -6, leftover: 0 });
  });

  it('returns to the newest output before pinning the pane back to the prompt', () => {
    expect(planSwipe(100, state({ paneMax: 200, linesDown: 3 }))).toEqual({ paneTop: 70, lines: 3, leftover: 0 });
  });

  it('stops at either end instead of banking travel for later', () => {
    expect(planSwipe(-100, state({ linesUp: 2 }))).toEqual({ paneTop: 0, lines: -2, leftover: 0 });
    expect(planSwipe(100, state({ paneTop: 200, paneMax: 200 }))).toEqual({ paneTop: 200, lines: 0, leftover: 0 });
  });
});
