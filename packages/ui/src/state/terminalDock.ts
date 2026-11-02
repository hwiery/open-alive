import type { ViewMode } from '../App.tsx';
import { TERMINAL_PANEL_POSITIONS, type TerminalOverlayMode } from './terminalViewSwitch.ts';

/**
 * Docked terminal panel: where it sits, how big it is, and how much room the
 * view underneath must leave for it.
 *
 * The panel position and size are remembered across reloads, so a layout such
 * as "tickets on top, terminal below" is set up once instead of every visit.
 */

export const TERMINAL_MODE_KEY = 'open-alive:terminal-mode';
export const TERMINAL_BOTTOM_HEIGHT_KEY = 'open-alive:terminal-bottom-height';
export const TERMINAL_RIGHT_WIDTH_KEY = 'open-alive:terminal-right-width';

/** First-run position: below the tickets, which is the layout the ticket flow wants. */
export const DEFAULT_TERMINAL_MODE: TerminalOverlayMode = 'bottom';
/** Default panel sizes before the user drags a resize handle (CSS lengths). */
export const DEFAULT_BOTTOM_HEIGHT = '50vh';
export const DEFAULT_RIGHT_WIDTH = 'min(480px, 40vw)';

type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage, or undefined where storage is disabled. */
export function browserStorage(): PrefStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readTerminalPref(storage: PrefStorage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Saved panel position. Fullscreen is a transient state, so it is never restored. */
export function loadTerminalMode(storage: PrefStorage | undefined): TerminalOverlayMode {
  const saved = readTerminalPref(storage, TERMINAL_MODE_KEY);
  return (TERMINAL_PANEL_POSITIONS as readonly string[]).includes(saved ?? '')
    ? (saved as TerminalOverlayMode)
    : DEFAULT_TERMINAL_MODE;
}

/** Saved panel size in px, or undefined when none (or an invalid one) is stored. */
export function loadDockSize(storage: PrefStorage | undefined, key: string): number | undefined {
  const saved = readTerminalPref(storage, key);
  if (saved === null) return undefined;
  const px = Number(saved);
  return Number.isFinite(px) && px > 0 ? px : undefined;
}

export function saveTerminalPref(storage: PrefStorage | undefined, key: string, value: string | number): void {
  try {
    storage?.setItem(key, typeof value === 'number' ? String(Math.round(value)) : value);
  } catch {
    // storage disabled: the choice is simply not remembered
  }
}

export interface TerminalDockInsets {
  bottom: number | string;
  right: number | string;
}

/**
 * Room a view must leave for a visible docked terminal. A floating or
 * fullscreen terminal reserves nothing — the first floats, the second replaces the view.
 */
export function terminalDockInsets(
  visible: boolean,
  mode: TerminalOverlayMode,
  bottomHeight?: number,
  rightWidth?: number,
): TerminalDockInsets {
  if (!visible) return { bottom: 0, right: 0 };
  if (mode === 'bottom') return { bottom: bottomHeight ?? DEFAULT_BOTTOM_HEIGHT, right: 0 };
  if (mode === 'right') return { bottom: 0, right: rightWidth ?? DEFAULT_RIGHT_WIDTH };
  return { bottom: 0, right: 0 };
}

/** Views that show the terminal as a panel beside their own content. */
const DOCK_VIEWS: ReadonlySet<ViewMode> = new Set<ViewMode>(['animation', 'tickets']);

export function canDockTerminal(view: ViewMode): boolean {
  return DOCK_VIEWS.has(view);
}
