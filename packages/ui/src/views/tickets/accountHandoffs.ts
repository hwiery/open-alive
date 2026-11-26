import type { Ticket } from '@open-alive/core';

/**
 * One line per account hand-off: "default → alt1 14:02". A restart (the run
 * had no session yet, so it began again from the goal) is marked as such.
 */
export function formatAccountHandoffs(ticket: Pick<Ticket, 'accountHandoffs'>, t: (key: string) => string): string | null {
  const list = ticket.accountHandoffs;
  if (!list || list.length === 0) return null;
  return list
    .map((h) => {
      const at = new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const restarted = h.resumed ? '' : ` (${t('tickets.runHandoffRestarted')})`;
      return `${h.from ?? t('tickets.runAccountDefault')} → ${h.to} ${at}${restarted}`;
    })
    .join(', ');
}
