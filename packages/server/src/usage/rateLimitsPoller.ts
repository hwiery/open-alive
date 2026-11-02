/**
 * Polls Claude's subscription usage windows (the same numbers `/usage` shows)
 * and publishes them for the header pills.
 *
 * Source: `GET https://api.anthropic.com/api/oauth/usage` with the Claude Code
 * OAuth access token. This is the endpoint Claude Code itself calls; it is not
 * a documented public API, so every field is parsed defensively and any shape
 * we do not recognise simply yields no snapshot rather than an error.
 *
 * The statusLine hook also exposes `rate_limits.five_hour/seven_day`, but it
 * carries no model-scoped window (Fable) and would require taking over the
 * user's single `statusLine` setting — hence the direct poll.
 *
 * SECURITY: the access token is read per-poll, used for one request, and never
 * stored, logged, or broadcast. Only percentages and reset times reach clients.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { UsageLimitsSnapshot, UsageWindow, ScopedUsageWindow } from '@open-alive/core';
import { fetchClaudeUsageViaCli } from './claudeCliUsage.js';

const execFileAsync = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
/** Keychain service name Claude Code stores its credentials under on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** 15 min: `/usage` moves slowly, and each poll starts a short `claude` process. */
const DEFAULT_INTERVAL_MS = 15 * 60_000;

const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Parse an ISO8601 reset timestamp into unix ms; null when absent or unparseable. */
function parseResetsAt(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Build a window from an API object carrying a 0-100 percentage under `key`. */
function toWindow(raw: unknown, key: 'utilization' | 'percent'): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const pct = asNum((raw as Record<string, unknown>)[key]);
  if (pct === null) return null;
  return { utilization: pct / 100, resetsAt: parseResetsAt((raw as Record<string, unknown>).resets_at) };
}

interface RawLimit {
  kind?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

function limitsOf(body: Record<string, unknown>): RawLimit[] {
  return Array.isArray(body.limits) ? (body.limits as RawLimit[]) : [];
}

/**
 * Normalize a `/api/oauth/usage` body into a snapshot.
 *
 * The top-level `five_hour`/`seven_day` objects are preferred; `limits[]` is the
 * fallback for both and the only source for model-scoped weekly windows.
 * Returns null when the body carries no usable window at all.
 */
export function parseUsageResponse(body: unknown, fetchedAt: number): UsageLimitsSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  const limits = limitsOf(obj);

  const byKind = (kind: string) => limits.find((l) => l.kind === kind) ?? null;

  const fiveHour = toWindow(obj.five_hour, 'utilization') ?? toWindow(byKind('session'), 'percent');
  const sevenDay = toWindow(obj.seven_day, 'utilization') ?? toWindow(byKind('weekly_all'), 'percent');

  const scopedWeekly: ScopedUsageWindow[] = [];
  for (const limit of limits) {
    if (limit.kind !== 'weekly_scoped') continue;
    const modelName = limit.scope?.model?.display_name;
    if (typeof modelName !== 'string' || modelName.length === 0) continue;
    const window = toWindow(limit, 'percent');
    if (!window) continue;
    scopedWeekly.push({ ...window, modelName });
  }

  if (!fiveHour && !sevenDay && scopedWeekly.length === 0) return null;
  return { fiveHour, sevenDay, scopedWeekly, fetchedAt, stale: false };
}

/**
 * Read the Claude Code OAuth access token.
 *
 * macOS keeps it in the login keychain (Claude Code refreshes it there), other
 * platforms in `~/.claude/.credentials.json`. The file is also the macOS
 * fallback for installs that predate the keychain migration. Returns null when
 * no credential is available — an API-key or non-subscriber install, where the
 * pills simply never appear.
 */
export async function readOAuthToken(): Promise<string | null> {
  const fromJson = (text: string): string | null => {
    try {
      const parsed = JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown } };
      const token = parsed.claudeAiOauth?.accessToken;
      return typeof token === 'string' && token.length > 0 ? token : null;
    } catch {
      return null;
    }
  };

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeout: 3000 },
      );
      const token = fromJson(stdout);
      if (token) return token;
    } catch {
      // No keychain entry (or access denied) — fall through to the file.
    }
  }

  try {
    return fromJson(await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
  } catch {
    return null;
  }
}

export interface UsageLimitsPollerOptions {
  intervalMs?: number;
  /** Primary source; injectable for tests. Defaults to `claude -p /usage`. */
  readCli?: () => Promise<UsageLimitsSnapshot | null>;
  /** Injectable for tests; defaults to reading the real credential store. */
  readToken?: () => Promise<string | null>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Last good snapshot is kept here so a restart shows it at once instead of nothing. */
  cacheFile?: string;
  now?: () => number;
}

/** First wait after a 429; doubles per consecutive 429 up to the cap. */
const BACKOFF_START_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * Periodically refreshes {@link UsageLimitsSnapshot}.
 *
 * Failure policy: a failed poll never clears the pills. The last good snapshot
 * is kept and re-published with `stale: true`, so a transient network blip or
 * an expired token dims the numbers instead of making them vanish.
 */
export class UsageLimitsPoller {
  private intervalMs: number;
  private readCli: () => Promise<UsageLimitsSnapshot | null>;
  private readToken: () => Promise<string | null>;
  private fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private handle: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: UsageLimitsSnapshot | null = null;
  private listeners = new Set<(snapshot: UsageLimitsSnapshot) => void>();

  private cacheFile: string | undefined;
  private now: () => number;
  /** The usage endpoint rate-limits (HTTP 429, Retry-After 0); polls pause until this time. */
  private backoffUntil = 0;
  private backoffMs = 0;

  constructor(options: UsageLimitsPollerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.readCli = options.readCli ?? (() => fetchClaudeUsageViaCli());
    this.readToken = options.readToken ?? readOAuthToken;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.cacheFile = options.cacheFile;
    this.now = options.now ?? Date.now;
    this.lastSnapshot = this.readCache();
  }

  start(): void {
    if (this.handle) return;
    void this.pollOnce();
    this.handle = setInterval(() => void this.pollOnce(), this.intervalMs);
    // Never hold the process open for a header indicator.
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  latest(): UsageLimitsSnapshot | null {
    return this.lastSnapshot;
  }

  subscribe(listener: (snapshot: UsageLimitsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * One fetch cycle. Exposed for tests and for the initial eager poll.
   *
   * Claude Code's own `/usage` comes first; the raw OAuth endpoint is only the
   * fallback (Claude Code missing or failing), and only it is subject to the
   * 429 backoff.
   */
  async pollOnce(): Promise<void> {
    const fromCli = await this.readCli().catch(() => null);
    if (fromCli) {
      this.publish(fromCli);
      this.writeCache(fromCli);
      return;
    }
    if (this.now() < this.backoffUntil) {
      this.markStale();
      return;
    }
    const snapshot = await this.fetchSnapshot();
    if (snapshot === 'rate-limited') {
      this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs ? this.backoffMs * 2 : BACKOFF_START_MS);
      this.backoffUntil = this.now() + this.backoffMs;
      this.markStale();
      return;
    }
    if (snapshot) {
      this.backoffMs = 0;
      this.backoffUntil = 0;
      this.publish(snapshot);
      this.writeCache(snapshot);
      return;
    }
    this.markStale();
  }

  /**
   * Failed poll: keep the previous values, flagged stale, so the UI can say the
   * fetch failed. With nothing fetched yet, an empty stale snapshot says the same.
   */
  private markStale(): void {
    if (this.lastSnapshot?.stale) return;
    this.publish(
      this.lastSnapshot
        ? { ...this.lastSnapshot, stale: true }
        : { fiveHour: null, sevenDay: null, scopedWeekly: [], fetchedAt: 0, stale: true },
    );
  }

  private publish(snapshot: UsageLimitsSnapshot): void {
    this.lastSnapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private readCache(): UsageLimitsSnapshot | null {
    if (!this.cacheFile) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as UsageLimitsSnapshot;
      // Shown as current until the eager first poll says otherwise (seconds after start).
      return parsed && typeof parsed === 'object' && Array.isArray(parsed.scopedWeekly) ? { ...parsed, stale: false } : null;
    } catch {
      return null;
    }
  }

  private writeCache(snapshot: UsageLimitsSnapshot): void {
    if (!this.cacheFile) return;
    try {
      // Percentages and reset times only — never the token.
      writeFileSync(this.cacheFile, JSON.stringify(snapshot), { mode: 0o600 });
    } catch {
      // a missing cache only costs the instant display after a restart
    }
  }

  private async fetchSnapshot(): Promise<UsageLimitsSnapshot | 'rate-limited' | null> {
    const token = await this.readToken();
    if (!token) return null;
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
        },
      });
      if (res.status === 429) return 'rate-limited';
      if (!res.ok) return null;
      return parseUsageResponse(await res.json(), this.now());
    } catch {
      return null;
    }
  }
}
