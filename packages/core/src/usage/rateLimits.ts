/**
 * Claude subscription rate-limit windows, as shown by Claude Code's `/usage`.
 *
 * The server polls Anthropic's OAuth usage endpoint and broadcasts this shape;
 * the UI renders it as header pills next to CPU/RAM. Only percentages and reset
 * timestamps ever leave the server — the OAuth token never does.
 */

/** One usage window (5-hour session, 7-day, or a model-scoped weekly limit). */
export interface UsageWindow {
  /** Fraction of the limit consumed, 0..1 (values above 1 are possible on overage). */
  utilization: number;
  /** Unix ms when the window resets, or null when the API reports none. */
  resetsAt: number | null;
}

/** A weekly window scoped to one model (e.g. Fable). */
export interface ScopedUsageWindow extends UsageWindow {
  /** Model display name as reported by the API, e.g. "Fable". */
  modelName: string;
}

export interface UsageLimitsSnapshot {
  /** 5-hour session window. */
  fiveHour: UsageWindow | null;
  /** 7-day (all models) window. */
  sevenDay: UsageWindow | null;
  /** Model-scoped weekly windows (Fable, Opus, …), in API order. */
  scopedWeekly: ScopedUsageWindow[];
  /** Wall-clock ms of the fetch this snapshot came from. */
  fetchedAt: number;
  /**
   * True when the most recent poll failed and these are the last known values.
   * The UI keeps rendering them, dimmed, rather than dropping the pills.
   */
  stale: boolean;
  /**
   * Codex subscription windows, read from the newest Codex session log (Codex
   * writes its rate limits there after every turn). Null when Codex is not
   * installed or has not run yet; `observedAt` says how fresh the numbers are.
   */
  codex?: CodexUsage | null;
  /**
   * Claude account rotation (`OA_CLAUDE_ACCOUNTS`). Present only with two or
   * more accounts; the top-level Claude windows are then the active account's.
   */
  claudeAccounts?: ClaudeAccountsUsage;
}

/** One rotation account's usage, as last read from `/usage` under its login. */
export interface ClaudeAccountUsage {
  name: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  scopedWeekly: ScopedUsageWindow[];
  /** Unix ms of the read; 0 when it has not been read yet. */
  fetchedAt: number;
  /** Set while the account takes no new runs (at the switch threshold, or it refused a run). */
  limitedUntil?: number;
  /** Why: `7d 99%`, or the CLI's limit message. */
  limitedReason?: string;
}

export interface ClaudeAccountsUsage {
  /** Account new ticket runs go to; null when every account is spent. */
  active: string | null;
  /** 0..1 utilization at which an account stops taking new runs. */
  threshold: number;
  accounts: ClaudeAccountUsage[];
}

export interface CodexUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Unix ms of the Codex event the numbers came from. */
  observedAt: number;
  /** True when the latest account read failed (logged out, Codex error); the numbers are last-known. */
  stale?: boolean;
}
