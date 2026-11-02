import type { ViewMode } from '../App.tsx';

/**
 * Navigation grouping for the header. Single source of truth for "which view
 * belongs to which tier". HeaderBar only renders this — it never re-decides
 * grouping.
 *
 * The header reads as two views — Tickets and Terminal — and the terminal has
 * three layouts (internal ids kept so saved state and links still resolve):
 * - window (`animation`): a resizable terminal window over the pixel office.
 * - split  (`spread`):    every terminal tiled side by side.
 * - full   (`list`):      one terminal covering the whole body.
 * Cost (internal id `board`) is a tool, shown on the right next to usage.
 */
export type ViewGroup = 'primary' | 'terminal' | 'tools';

export interface ViewModeMeta {
  mode: ViewMode;
  labelKey: string;
  group: ViewGroup;
}

const LEGACY_BOARD_MODES: ReadonlySet<ViewMode> = new Set([
  'prompt',
  'archive',
  'ticketMgmt',
  'data',
]);

/**
 * Keep legacy links usable: standalone analytics views moved into Cost
 * (`board`), and the removed workspace view falls back to tickets.
 */
export function normalizeViewMode(mode: ViewMode): ViewMode {
  if (mode === 'workspace') return 'tickets';
  return LEGACY_BOARD_MODES.has(mode) ? 'board' : mode;
}

/**
 * Ordered nav metadata. `jarvis` is intentionally omitted — it is not surfaced
 * in the header (matches prior behaviour).
 */
export const VIEW_MODE_META: readonly ViewModeMeta[] = [
  { mode: 'tickets', labelKey: 'viewMode.tickets', group: 'primary' },
  { mode: 'animation', labelKey: 'viewMode.layout.window', group: 'terminal' },
  { mode: 'spread', labelKey: 'viewMode.layout.split', group: 'terminal' },
  { mode: 'list', labelKey: 'viewMode.layout.full', group: 'terminal' },
  // Internal id `board` kept for saved state; the view is now cost analytics only.
  { mode: 'board', labelKey: 'viewMode.cost', group: 'tools' },
  // `backends` (backend connection) moved into the Settings modal (backend tab),
  // so it is no longer a standalone tools view.
];

/** Views in a given group, preserving declaration order. */
export function viewsInGroup(group: ViewGroup): ViewModeMeta[] {
  return VIEW_MODE_META.filter((m) => m.group === group);
}

/** The group a view belongs to, or undefined if it is not surfaced in the header. */
export function groupOf(mode: ViewMode): ViewGroup | undefined {
  return VIEW_MODE_META.find((m) => m.mode === mode)?.group;
}

/** The terminal layout to show when the user picks "Terminal" without choosing one. */
export const DEFAULT_TERMINAL_VIEW: ViewMode = 'animation';

/** True for the three terminal layouts. */
export function isTerminalView(mode: ViewMode): boolean {
  return groupOf(mode) === 'terminal';
}
