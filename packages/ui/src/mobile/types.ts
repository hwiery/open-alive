/**
 * Callback types for the phone screens.
 *
 * These live in a `.ts` file on purpose: an inline `=> Promise<…>` inside a
 * `.tsx` file trips the i18n raw-text guard's JSX heuristic, which reads the
 * type argument as untranslated UI text. The same convention is used by
 * `views/tickets/useTickets.ts`.
 */
import type { TicketLocation } from '@open-alive/core';

export interface MobileProject {
  path: string;
  name: string;
}

/** Everything the composer collects, in the shape `useTickets.createTicket` takes. */
export interface MobileTicketDraft {
  goal: string;
  cwd: string;
  location?: TicketLocation;
  orchestrated: boolean;
  /** Full model id (Claude, or Codex for a local run). */
  model: string;
  /** Run profile = reasoning effort. */
  effort: string;
  autoCommit: boolean;
  panelReview: boolean;
}

/** Creates a ticket; resolves null on success or the server's message on failure. */
export type MobileCreateFn = (draft: MobileTicketDraft) => Promise<string | null>;

/** Answers a parked decision; resolves true when the reply was accepted. */
export type MobileReplyFn = (prompt: string) => Promise<boolean>;
