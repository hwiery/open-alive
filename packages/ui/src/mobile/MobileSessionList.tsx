import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { projectName } from '../views/tickets/ticketDisplay.ts';
import { browserStorage, readTerminalPref, saveTerminalPref } from '../state/terminalDock.ts';
import { COLORS, screen, body, card, TYPE, clamp1, clamp2 } from './styles.ts';
import { PullToRefresh } from './PullToRefresh.tsx';
import { SESSION_STATUS_COLOR, groupByProject, relativeTime, splitSessions, type LiveSessions, type ProjectGroup, type SessionRow } from './sessionStatus.ts';

export interface MobileSession {
  sessionId: string;
  /** Claude's own session id — the key the PC's live agent list uses. */
  providerSessionId: string;
  displayName: string;
  state: string;
  cwd: string;
  lastActivityAt: number;
  /** The session is blocked on a human approving a tool call. */
  needsApproval: boolean;
  /** Tool running right now, if the catalog knows. */
  currentTool?: string;
  /** The workspace's name as the PC shows it (custom name, repo, folder). */
  projectName?: string;
}

export interface MobileSessionListProps {
  sessions: MobileSession[];
  loading: boolean;
  /** Why the list could not be fetched; null when the last fetch worked. */
  error?: string | null;
  onOpen: (sessionId: string) => void;
  /** Refetch, for the pull gesture. */
  onRefresh?: () => void | Promise<void>;
  /** The PC's live sessions (what its sidebar shows); null while unknown. */
  live?: LiveSessions;
  /** Clock for "5분 전"; injectable for tests. */
  now?: number;
}

const SHOW_ENDED_KEY = 'open-alive:mobile-show-ended';

/**
 * Sessions on this machine: what is running now on top, ended ones folded away.
 *
 * Each card leads with what you open the phone to learn — is it waiting on me,
 * which session is it, and when did it last move — and only then where it runs.
 */
export function MobileSessionList({ sessions, loading, error = null, onOpen, onRefresh, live = null, now = Date.now() }: MobileSessionListProps) {
  const { t } = useTranslation();
  const [showEnded, setShowEnded] = useState(() => readTerminalPref(browserStorage(), SHOW_ENDED_KEY) === '1');
  const { active, ended } = useMemo(() => splitSessions(sessions, live), [sessions, live]);

  const toggleEnded = () => {
    const next = !showEnded;
    setShowEnded(next);
    saveTerminalPref(browserStorage(), SHOW_ENDED_KEY, next ? '1' : '0');
  };

  const renderRow = ({ session: s, status }: SessionRow) => {
    const label = t(`mobile.sessionStatus.${status}`);
    const color = SESSION_STATUS_COLOR[status];
    const tool = status === 'working' && s.currentTool ? s.currentTool : null;
    return (
      <button
        key={s.sessionId}
        style={{ ...card, opacity: status === 'ended' ? 0.72 : 1 }}
        onClick={() => onOpen(s.sessionId)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
          <span aria-label={label} style={{ ...TYPE.label, fontWeight: 700, color, flexShrink: 0 }}>{label}</span>
          {tool && <span style={{ ...TYPE.meta, ...clamp1, color: COLORS.muted }}>{tool}</span>}
          <span style={{ ...TYPE.meta, color: COLORS.muted, marginLeft: 'auto', flexShrink: 0 }}>
            {relativeTime(now, s.lastActivityAt, t)}
          </span>
        </div>
        <div style={{ ...TYPE.body, ...clamp2, fontWeight: 600 }}>{s.displayName || s.sessionId.slice(0, 12)}</div>
      </button>
    );
  };

  /**
   * One project root, as the PC sidebar groups it: the folder name in bold with
   * the tail of its path, so two checkouts of the same repo cannot be mixed up,
   * then its sessions.
   */
  const renderGroup = ({ key, rows }: ProjectGroup) => {
    const name = rows[0]?.session.projectName || projectName(key) || t('mobile.noProject');
    return (
      <section key={key} aria-label={name} style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 2px 6px' }}>
          <span style={{ ...TYPE.label, fontWeight: 700, color: COLORS.text, flexShrink: 0, maxWidth: '60%', ...clamp1 }}>{name}</span>
          <span style={{ ...TYPE.meta, ...clamp1, color: COLORS.muted, minWidth: 0 }}>{pathTail(key)}</span>
          <span style={{ ...TYPE.meta, color: COLORS.muted, marginLeft: 'auto', flexShrink: 0 }}>{rows.length}</span>
        </div>
        {rows.map(renderRow)}
      </section>
    );
  };

  const empty = active.length === 0 && ended.length === 0;

  return (
    // `screen` is absolutely positioned on purpose: overriding it to `relative`
    // let the list grow to its content height, so the pane never scrolled.
    <div style={screen}>
      {/* No title bar — the tab above names this list. Bottom padding (from
          `body`) clears the fixed "new terminal" bar. */}
      <PullToRefresh onRefresh={onRefresh} style={{ ...body, paddingTop: 12 }}>
        {error && (
          <p role="alert" style={{ ...TYPE.body, color: 'var(--accent-red)', margin: '8px 2px 16px' }}>
            {t('mobile.sessionsError', { detail: error })}
          </p>
        )}
        {loading && empty && !error ? (
          <p style={{ ...TYPE.body, color: COLORS.muted, textAlign: 'center', marginTop: 48 }}>{t('mobile.sessionsLoading')}</p>
        ) : (
          <>
            {active.length === 0 && !error && (
              <p style={{ ...TYPE.body, color: COLORS.muted, textAlign: 'center', margin: '32px 0' }}>{t('mobile.sessionsEmpty')}</p>
            )}
            {groupByProject(active).map(renderGroup)}
            {ended.length > 0 && (
              <>
                <button
                  onClick={toggleEnded}
                  aria-expanded={showEnded}
                  style={{
                    ...TYPE.label, display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                    background: 'none', border: 'none', color: COLORS.muted, cursor: 'pointer',
                    padding: '12px 2px 8px', fontWeight: 600,
                  }}
                >
                  <span>{showEnded ? '▾' : '▸'}</span>
                  {t('mobile.endedSection', { count: ended.length })}
                </button>
                {showEnded && groupByProject(ended).map(renderGroup)}
              </>
            )}
          </>
        )}
      </PullToRefresh>
    </div>
  );
}

/** Last two path segments (`work/app`): enough to tell same-named folders apart. */
export function pathTail(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}
