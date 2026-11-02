import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useSettings, resolveTerminalTheme, getFontFamily, TERMINAL_MIN_CONTRAST, effectiveTerminalBackground } from '../services/settings.ts';
import { useAppTheme } from '../services/appearance.ts';
import type { TermFeed } from './termFeed.ts';

/**
 * The phone's terminal pane — the same emulator the desktop uses.
 *
 * Claude Code redraws by moving the cursor up and erasing lines, and spaces
 * words with column jumps. A text pane that strips those sequences turns every
 * redraw into appended blank lines and glues words together, so the phone runs
 * a real xterm instead.
 *
 * It renders at the pty's own grid (sent by the server as `terminal:size`)
 * rather than fitting a grid to the phone: resizing a shared pty would reflow
 * the desktop's view too. To keep the layout identical, the font shrinks until
 * the columns fit the width; below a readable floor it stops shrinking and the
 * pane scrolls sideways instead.
 */

/** Smallest font worth rendering; narrower grids scroll horizontally. */
export const MIN_FONT_PX = 7;
/** Floor in zoomed mode: comfortable to read, and the pane scrolls sideways. */
export const READABLE_FONT_PX = 11;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Monospace cell width per 1px of font size, when it cannot be measured. */
const FALLBACK_CELL_RATIO = 0.6;

/** Font size (0.1px steps) that fits `cols` cells into `available` px, clamped. */
export function fitFontSize(available: number, cols: number, cellRatio: number, max: number, min = MIN_FONT_PX): number {
  if (available <= 0 || cols <= 0 || cellRatio <= 0) return max;
  const size = Math.floor((available / (cols * cellRatio)) * 10) / 10;
  return Math.min(max, Math.max(Math.min(min, max), size));
}

/** Fewest rows a phone-owned shell is given, however short the pane. */
export const MIN_FIT_ROWS = 10;

/** Rows of `cellHeight` px that fit in `available` px; null until the cell is measured. */
export function rowsThatFit(available: number, cellHeight: number): number | null {
  if (cellHeight <= 0) return null;
  return Math.max(MIN_FIT_ROWS, Math.floor(available / cellHeight));
}

export interface SwipeState {
  /** Pane scroll offset; above 0 only when the terminal grid is taller than the pane. */
  paneTop: number;
  paneMax: number;
  /** History lines above / below the terminal's current viewport. */
  linesUp: number;
  linesDown: number;
  cellHeight: number;
}

export interface SwipePlan {
  paneTop: number;
  /** Lines to scroll the terminal; negative = back in history. */
  lines: number;
  /** Sub-line travel to add to the next move. */
  leftover: number;
}

/**
 * Split `delta` px of finger travel (positive = finger up = newer output)
 * between the pane and the terminal's history.
 *
 * Going back, the pane first reveals the top rows of a grid taller than itself,
 * then history scrolls; coming forward retraces that path, so the prompt is
 * where the swipe ends. Travel past either end is dropped, not banked.
 */
export function planSwipe(delta: number, s: SwipeState): SwipePlan {
  if (s.cellHeight <= 0) return { paneTop: s.paneTop, lines: 0, leftover: 0 };
  let rest = delta;
  let paneTop = s.paneTop;
  let lines = 0;
  if (rest < 0) {
    const take = Math.min(-rest, paneTop);
    paneTop -= take;
    rest += take;
    lines = Math.max(-s.linesUp, Math.trunc(rest / s.cellHeight)) || 0;
    rest = lines === -s.linesUp ? 0 : rest - lines * s.cellHeight;
  } else if (rest > 0) {
    lines = Math.min(s.linesDown, Math.trunc(rest / s.cellHeight));
    rest -= lines * s.cellHeight;
    if (lines === s.linesDown) {
      const take = Math.min(rest, s.paneMax - paneTop);
      paneTop += take;
      rest = paneTop >= s.paneMax ? 0 : rest - take;
    }
  }
  return { paneTop, lines, leftover: rest || 0 };
}

/** Fling: px/ms below which it stops, and the decay per 16ms frame. */
const FLING_MIN_SPEED = 0.05;
const FLING_DECAY = 0.95;

function measureCellRatio(fontFamily: string): number {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return FALLBACK_CELL_RATIO;
    ctx.font = `100px ${fontFamily}`;
    const ratio = ctx.measureText('W').width / 100;
    return ratio > 0 ? ratio : FALLBACK_CELL_RATIO;
  } catch {
    return FALLBACK_CELL_RATIO;
  }
}

export interface MobileXtermProps {
  feed: TermFeed;
  /** Keep the font at a readable size and scroll sideways rather than shrink to fit. */
  zoomed?: boolean;
  /**
   * Rows the pane can show at the current font. Only a pty the phone owns may
   * be resized to it — resizing a shared one would reflow the desktop too.
   */
  onFitRows?: (rows: number) => void;
}

export function MobileXterm({ feed, zoomed = false, onFitRows }: MobileXtermProps) {
  const settings = useSettings().terminal;
  const appTheme = useAppTheme();
  const theme = resolveTerminalTheme(settings.themeId, settings.colorOverrides, appTheme);
  const fontFamily = getFontFamily(settings.fontFamilyId);

  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const gridRef = useRef({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  // Read by `refit`, which runs from observers and feed events outside render.
  const minFont = zoomed ? READABLE_FONT_PX : MIN_FONT_PX;
  const fontRef = useRef({ family: fontFamily, max: settings.fontSize, min: minFont });
  fontRef.current = { family: fontFamily, max: settings.fontSize, min: minFont };

  const onFitRowsRef = useRef(onFitRows);
  onFitRowsRef.current = onFitRows;
  const fitRowsRef = useRef<number | null>(null);
  const cellHeightRef = useRef(0);

  // The pane follows the prompt until a swipe moves it off the bottom.
  const stickBottomRef = useRef(true);

  const refit = () => {
    const term = termRef.current;
    const wrap = wrapRef.current;
    const host = hostRef.current;
    if (!term || !wrap) return;
    const { cols, rows } = gridRef.current;
    const { family, max, min } = fontRef.current;
    const size = fitFontSize(wrap.clientWidth, cols, measureCellRatio(family), max, min);
    if (term.options.fontSize !== size) term.options.fontSize = size;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    if (!host) return;
    const height = host.getBoundingClientRect().height;
    cellHeightRef.current = term.rows > 0 ? height / term.rows : 0;
    if (stickBottomRef.current) wrap.scrollTop = wrap.scrollHeight - wrap.clientHeight;
    const fit = rowsThatFit(wrap.clientHeight, cellHeightRef.current);
    if (fit !== null && fit !== fitRowsRef.current) {
      fitRowsRef.current = fit;
      onFitRowsRef.current?.(fit);
    }
  };

  // xterm 6 registers no touch handling of its own, so every vertical swipe
  // over the pane — terminal or blank space — is turned into scrolling here.
  const swipeRef = useRef<{ y: number; t: number; carry: number; speed: number } | null>(null);
  const flingRef = useRef<number | null>(null);

  /** Apply `delta` px of travel; false when there was nothing left to scroll. */
  const scrollBy = (delta: number): boolean => {
    const term = termRef.current;
    const wrap = wrapRef.current;
    const swipe = swipeRef.current;
    if (!term || !wrap) return false;
    const { viewportY, baseY } = term.buffer.active;
    const paneMax = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    const plan = planSwipe(delta + (swipe?.carry ?? 0), {
      paneTop: wrap.scrollTop, paneMax, linesUp: viewportY, linesDown: baseY - viewportY, cellHeight: cellHeightRef.current,
    });
    if (plan.lines !== 0) term.scrollLines(plan.lines);
    const moved = plan.lines !== 0 || plan.paneTop !== wrap.scrollTop;
    wrap.scrollTop = plan.paneTop;
    stickBottomRef.current = plan.paneTop >= paneMax - 1;
    if (swipe) swipe.carry = plan.leftover;
    return moved;
  };

  const stopFling = () => {
    if (flingRef.current !== null) cancelAnimationFrame(flingRef.current);
    flingRef.current = null;
  };

  const onTouchStart = (e: React.TouchEvent) => {
    stopFling();
    const y = e.touches[0]?.clientY;
    swipeRef.current = y === undefined ? null : { y, t: performance.now(), carry: 0, speed: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const swipe = swipeRef.current;
    const y = e.touches[0]?.clientY;
    if (!swipe || y === undefined) return;
    const now = performance.now();
    const delta = swipe.y - y;
    // Smoothed so one jittery last sample does not decide the fling.
    swipe.speed = 0.8 * (delta / Math.max(1, now - swipe.t)) + 0.2 * swipe.speed;
    swipe.y = y;
    swipe.t = now;
    scrollBy(delta);
  };
  // A quick flick keeps scrolling and slows down, as native lists do.
  const onTouchEnd = () => {
    const swipe = swipeRef.current;
    if (!swipe || Math.abs(swipe.speed) < FLING_MIN_SPEED || typeof requestAnimationFrame !== 'function') return;
    let speed = swipe.speed;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.max(1, now - last);
      last = now;
      speed *= FLING_DECAY ** (dt / 16);
      if (Math.abs(speed) < FLING_MIN_SPEED || !scrollBy(speed * dt)) {
        flingRef.current = null;
        return;
      }
      flingRef.current = requestAnimationFrame(step);
    };
    flingRef.current = requestAnimationFrame(step);
  };
  useEffect(() => stopFling, []);

  // One emulator per mount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cols: gridRef.current.cols,
      rows: gridRef.current.rows,
      fontFamily: fontRef.current.family,
      fontSize: fontRef.current.max,
      lineHeight: settings.lineHeight,
      theme,
      scrollback: settings.scrollback,
      allowTransparency: true,
      minimumContrastRatio: TERMINAL_MIN_CONTRAST,
      // Typing goes through the input bar; a focused xterm would raise the
      // soft keyboard on every tap meant as a scroll.
      disableStdin: true,
      cursorBlink: false,
    });
    term.open(host);
    termRef.current = term;
    refit();

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => refit()) : null;
    if (wrapRef.current) observer?.observe(wrapRef.current);
    // The host changes size after a font change renders; re-measure the cell then.
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      termRef.current = null;
      term.dispose();
    };
    // Mount-only: later settings changes are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drain the socket's events into the emulator. A new feed is a new session.
  useEffect(() => {
    termRef.current?.reset();
    return feed.listen((event) => {
      const term = termRef.current;
      if (!term) return;
      if (event.kind === 'data') term.write(event.data);
      else if (event.kind === 'reset') term.reset();
      else {
        gridRef.current = { cols: event.cols, rows: event.rows };
        refit();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed]);

  // Follow the appearance settings the desktop terminal follows.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = theme;
    term.options.fontFamily = fontFamily;
    term.options.lineHeight = settings.lineHeight;
    refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.themeId, settings.colorOverrides, appTheme, fontFamily, settings.lineHeight, settings.fontSize, zoomed]);

  return (
    <div
      ref={wrapRef}
      data-testid="mobile-xterm"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      style={{
        width: '100%', flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden',
        // Horizontal pans stay native; vertical ones are `scrollBy`'s.
        touchAction: 'pan-x', overscrollBehavior: 'contain',
        background: effectiveTerminalBackground(theme, appTheme),
      }}
    >
      <div ref={hostRef} style={{ display: 'inline-block' }} />
    </div>
  );
}
