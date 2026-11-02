/**
 * Left-edge insets for everything that positions itself against the viewport.
 *
 * The shell lays the sidebar out with flexbox, but overlays and docks use
 * `position: fixed` — they sit outside that flow and would otherwise cover the
 * sidebar. They read their left edge from here instead of hardcoding a width,
 * so the sidebar's size lives in exactly one place.
 */

/** Width of the shared repo sidebar. Must match RepoSidebar's own width. */
export const REPO_SIDEBAR_WIDTH = 280;

/** Width of the per-view agent sidebar (list and animation views). */
export const PROJECT_SIDEBAR_WIDTH = 300;

/**
 * Which left sidebar a view shows — exactly one, never both.
 *
 * - `repo`: repo → branch → ticket tree with the project filter and open-work
 *   count. It drives the ticket views (tickets, board, workspace) and spread.
 * - `sessions`: live Claude sessions grouped by project, linked to the terminal
 *   tabs and the pixel characters. The animation and list views are about those
 *   sessions, and the repo filter does not apply to them, so showing both put two
 *   project lists side by side (580px) with the same projects in each.
 */
export type SidebarKind = 'repo' | 'sessions';

const SESSION_VIEWS: ReadonlySet<string> = new Set(['animation', 'list']);

export function sidebarFor(view: string): SidebarKind {
  return SESSION_VIEWS.has(view) ? 'sessions' : 'repo';
}

export interface LayoutInsets {
  /** Past the view's sidebar. For the to-do dock and the body-wide terminal modes. */
  body: number;
  /** Past every sidebar the list layout shows. For the terminal's list mode. */
  list: number;
}

/**
 * Both sidebars answer to the header's single left-panel toggle, so one flag
 * plus the view decides every inset. Collapsed sidebars render at width 0, not
 * a rail, which is why the collapsed case is a flat zero.
 */
export function layoutInsets(leftPanelOpen: boolean, view = 'tickets'): LayoutInsets {
  if (!leftPanelOpen) return { body: 0, list: 0 };
  const width = sidebarFor(view) === 'sessions' ? PROJECT_SIDEBAR_WIDTH : REPO_SIDEBAR_WIDTH;
  return { body: width, list: width };
}
