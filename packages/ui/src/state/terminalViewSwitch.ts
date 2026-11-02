import { normalizeViewMode } from '../components/viewGroups.ts';
import type { ViewMode } from '../App.tsx';

/** Overlay layout modes reported by ChatOverlay (mirrors its internal TerminalMode). */
export type TerminalOverlayMode = 'popup' | 'bottom' | 'right' | 'fullscreen';

/** Views whose body is the terminal itself — selecting them must not hide it. */
const TERMINAL_VIEWS: ReadonlySet<ViewMode> = new Set<ViewMode>(['list', 'spread']);

/**
 * A fullscreen terminal covers the whole body. Picking a view tab in the header is a
 * request to see that view, so the terminal is minimised first — including a click
 * on the view the terminal is already covering. Views that embed the terminal keep it.
 */
export function shouldCollapseTerminalOnViewSelect(
  terminalVisible: boolean,
  terminalMode: TerminalOverlayMode,
  target: ViewMode,
): boolean {
  if (!terminalVisible || terminalMode !== 'fullscreen') return false;
  return !TERMINAL_VIEWS.has(normalizeViewMode(target));
}

/** Header → terminal overlay: place the window-layout panel (floating / bottom / right). */
export const TERMINAL_SET_MODE_EVENT = 'open-alive:terminal-set-mode';

/** Panel positions offered in the header for the window layout. */
export const TERMINAL_PANEL_POSITIONS = ['popup', 'bottom', 'right'] as const satisfies readonly TerminalOverlayMode[];
