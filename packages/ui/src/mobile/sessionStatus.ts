import type { AgentState } from '@open-alive/core';
import type { MobileSession } from './MobileSessionList.tsx';

/**
 * What a phone needs to know about a session at a glance, in priority order.
 *
 * The catalog behind the list keeps every session ever run, and its state is
 * only as fresh as the last event it saw — sessions whose end it missed still
 * read `starting`. The PC's live agent list is what the desktop sidebar shows,
 * so when it is known it decides; the catalog state is the offline fallback.
 */
export type SessionStatus = 'approval' | 'waiting' | 'error' | 'working' | 'starting' | 'idle' | 'ended';

const PRIORITY: Record<SessionStatus, number> = {
  approval: 0, waiting: 1, error: 2, working: 3, starting: 4, idle: 5, ended: 6,
};

export const SESSION_STATUS_COLOR: Record<SessionStatus, string> = {
  approval: 'var(--accent-amber)',
  waiting: 'var(--accent-amber)',
  error: 'var(--accent-red)',
  working: 'var(--accent-green)',
  starting: 'var(--accent-purple)',
  idle: 'var(--accent-blue)',
  ended: 'var(--text-secondary)',
};

const FROM_AGENT: Record<AgentState, SessionStatus> = {
  active: 'working',
  waiting: 'waiting',
  listening: 'idle',
  idle: 'idle',
  spawning: 'starting',
  error: 'error',
  done: 'ended',
  despawning: 'ended',
  removed: 'ended',
};

const FROM_CATALOG: Record<string, SessionStatus> = {
  'using-tool': 'working',
  thinking: 'working',
  'waiting-user': 'waiting',
  paused: 'waiting',
  ready: 'idle',
  starting: 'starting',
};

/** Live = the PC's agent list keyed by Claude session id; null while it is unknown. */
export type LiveSessions = ReadonlyMap<string, AgentState> | null;

export function sessionStatus(session: MobileSession, live: LiveSessions): SessionStatus {
  const base = live
    ? FROM_AGENT[live.get(session.providerSessionId) ?? 'removed']
    : FROM_CATALOG[session.state] ?? 'ended';
  if (base === 'ended') return 'ended';
  return session.needsApproval ? 'approval' : base;
}

export interface SessionRow {
  session: MobileSession;
  status: SessionStatus;
}

/** Ended sessions beyond this are history, not something to open from a phone. */
export const MAX_ENDED = 30;
/** Running rows shown; only the offline catalog fallback ever gets near it. */
export const MAX_ACTIVE = 60;
/**
 * A blocked session is lifted to the top only if it moved within this window of
 * the newest one: offline, the catalog can hold a month-old `waiting-user`.
 */
const RECENT_MS = 60 * 60 * 1000;

/**
 * Running sessions (blocked first, then most recent) and ended ones (most
 * recent first, capped). Capped after sorting so the newest survive the cut.
 */
export function splitSessions(
  sessions: readonly MobileSession[],
  live: LiveSessions,
  maxEnded = MAX_ENDED,
): { active: SessionRow[]; ended: SessionRow[] } {
  const rows = sessions.map((session) => ({ session, status: sessionStatus(session, live) }));
  const newest = sessions.reduce((max, s) => Math.max(max, s.lastActivityAt), 0);
  const byRecency = (a: SessionRow, b: SessionRow) => b.session.lastActivityAt - a.session.lastActivityAt;
  const blocked = (r: SessionRow) =>
    PRIORITY[r.status] <= PRIORITY.waiting && newest - r.session.lastActivityAt < RECENT_MS ? 0 : 1;
  const active = rows
    .filter((r) => r.status !== 'ended')
    .sort((a, b) => blocked(a) - blocked(b) || byRecency(a, b))
    .slice(0, MAX_ACTIVE);
  const ended = rows.filter((r) => r.status === 'ended').sort(byRecency).slice(0, maxEnded);
  return { active, ended };
}

export interface ProjectGroup {
  /** Project root: the workspace path the PC sidebar groups by. */
  key: string;
  rows: SessionRow[];
}

/**
 * Rows bucketed by project root, keeping the order they came in: the group
 * holding the first (most urgent / most recent) row comes first, and rows keep
 * their order inside a group. Grouping after sorting, rather than sorting
 * groups separately, keeps "blocked first" true across the whole screen.
 */
export function groupByProject(rows: readonly SessionRow[]): ProjectGroup[] {
  const groups = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.session.cwd);
    if (bucket) bucket.push(row);
    else groups.set(row.session.cwd, [row]);
  }
  return Array.from(groups, ([key, grouped]) => ({ key, rows: grouped }));
}

type Translate = (key: string, opts?: { count?: number }) => string;

/** "5분 전" — the largest unit that fits. Empty when the time is unknown. */
export function relativeTime(now: number, at: number, t: Translate): string {
  if (!at) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return t('time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });
  return t('time.daysAgo', { count: Math.floor(hours / 24) });
}
