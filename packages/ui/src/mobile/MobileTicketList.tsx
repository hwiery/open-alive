import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Ticket, TicketEvaluation } from '@open-alive/core';
import { displayStatus, STATUS_COLOR, projectName, ticketLastActivityAt } from '../views/tickets/ticketDisplay.ts';
import { COLORS, screen, body, card, chip, primaryButton, actionBar, TYPE, clamp1, clamp2 } from './styles.ts';
import { PullToRefresh } from './PullToRefresh.tsx';
import { relativeTime } from './sessionStatus.ts';

export interface MobileTicketListProps {
  tickets: Ticket[];
  evaluations: Record<string, TicketEvaluation>;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Live socket state; a disconnected phone is showing stale rows. */
  connected?: boolean;
  /** Refetch, for the pull gesture. Absent = the gesture does nothing. */
  onRefresh?: () => void | Promise<void>;
  /** Clock for "5분 전"; injectable for tests. */
  now?: number;
}

type Filter = 'all' | 'active' | 'decision' | 'done';

const MATCHES: Record<Filter, (t: Ticket) => boolean> = {
  all: () => true,
  active: (t) => t.state === 'queued' || t.state === 'running' || t.state === 'verifying',
  decision: (t) => t.state === 'decision',
  done: (t) => t.state === 'done' || t.state === 'failed',
};

/**
 * The phone's home screen: everything that is waiting on you, newest activity
 * first — except tickets parked on a question, which are pinned to the top.
 * Those are the only ones where nothing moves until you act, and on a phone you
 * are usually opening the app precisely because something is stuck.
 */
export function MobileTicketList({ tickets, evaluations, onOpen, onNew, connected = true, onRefresh, now = Date.now() }: MobileTicketListProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo(() => {
    const visible = tickets.filter(MATCHES[filter]);
    return [...visible].sort((a, b) => {
      const blocked = (x: Ticket) => (x.state === 'decision' ? 0 : 1);
      if (blocked(a) !== blocked(b)) return blocked(a) - blocked(b);
      return ticketLastActivityAt(b) - ticketLastActivityAt(a);
    });
  }, [tickets, filter]);

  const counts: Record<Filter, number> = {
    all: tickets.length,
    active: tickets.filter(MATCHES.active).length,
    decision: tickets.filter(MATCHES.decision).length,
    done: tickets.filter(MATCHES.done).length,
  };

  const tabs: Array<{ id: Filter; text: string }> = [
    { id: 'all', text: t('mobile.filterAll') },
    { id: 'active', text: t('mobile.filterActive') },
    { id: 'decision', text: t('mobile.filterDecision') },
    { id: 'done', text: t('mobile.filterDone') },
  ];

  return (
    <div style={screen}>
      {/* No title bar: the tab above already says which list this is, and a
          390px screen has no vertical space for a heading that repeats it. */}
      {!connected && (
        <div style={{ padding: '8px 12px 0', fontSize: 12, color: 'var(--accent-red)', flexShrink: 0 }}>{t('mobile.offline')}</div>
      )}

      <div role="tablist" style={{ display: 'flex', gap: 6, padding: '10px 12px 0', overflowX: 'auto', flexShrink: 0 }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={filter === tab.id}
            onClick={() => setFilter(tab.id)}
            style={{
              ...chip,
              border: `1px solid ${filter === tab.id ? COLORS.accent : COLORS.border}`,
              background: filter === tab.id ? COLORS.accent : 'transparent',
              color: filter === tab.id ? 'var(--on-accent)' : COLORS.muted,
            }}
          >
            {tab.text} {counts[tab.id]}
          </button>
        ))}
      </div>

      <PullToRefresh onRefresh={onRefresh} style={body}>
        {rows.length === 0 ? (
          <p style={{ ...TYPE.body, color: COLORS.muted, textAlign: 'center', marginTop: 48 }}>{t('mobile.empty')}</p>
        ) : (
          rows.map((ticket) => {
            const status = displayStatus(ticket.state, evaluations[ticket.id]);
            return (
              <button key={ticket.id} style={card} onClick={() => onOpen(ticket.id)}>
                {/* State and last movement first: that is what the phone is opened to check. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: STATUS_COLOR[status], flexShrink: 0 }} />
                  <span style={{ ...TYPE.label, fontWeight: 700, color: STATUS_COLOR[status], flexShrink: 0 }}>
                    {t(`tickets.columns.${status}`)}
                  </span>
                  <span style={{ ...TYPE.meta, color: COLORS.muted }}>#{ticket.seq}</span>
                  <span style={{ ...TYPE.meta, color: COLORS.muted, marginLeft: 'auto', flexShrink: 0 }}>
                    {relativeTime(now, ticketLastActivityAt(ticket), t)}
                  </span>
                </div>
                <div style={{ ...TYPE.body, ...clamp2, fontWeight: 600 }}>{ticket.goal}</div>
                {ticket.headline && (
                  <div style={{ ...TYPE.body, ...clamp1, color: COLORS.muted, marginTop: 4 }}>{ticket.headline}</div>
                )}
                <div style={{ ...TYPE.meta, ...clamp1, color: COLORS.muted, marginTop: 4 }}>{projectName(ticket.cwd)}</div>
              </button>
            );
          })
        )}
      </PullToRefresh>

      <div style={actionBar}>
        <button style={primaryButton} onClick={onNew}>{t('mobile.newTicket')}</button>
      </div>
    </div>
  );
}
