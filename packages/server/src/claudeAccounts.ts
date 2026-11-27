/**
 * Claude account rotation for tickets.
 *
 * When one Claude subscription's usage window is spent, a ticket moves to
 * another account the user has signed in to and continues the same session
 * with `--resume`. Each account is a Claude Code config directory
 * (`CLAUDE_CONFIG_DIR`): Claude Code keeps one login per directory (on macOS a
 * keychain item whose name carries a hash of the path), so an account is
 * chosen per process just by setting that variable. `CLAUDE_CODE_OAUTH_TOKEN`
 * is deliberately not used: Claude Code drops connectors and local MCP servers
 * when it is set.
 *
 * Two triggers move work off an account:
 *  - proactive: `/usage` shows a window at or above the switch threshold
 *    (default 99%) → the account is skipped for new runs until that window resets;
 *  - reactive: a run fails with the CLI's usage-limit message → the account is
 *    benched and the ticket resumes on the next usable account.
 *
 * A running session is never moved before it is stopped: the prompt cache is
 * per account, so a move re-sends the whole context.
 *
 * Config (`~/.open-alive/.env` or process env):
 *   OA_CLAUDE_ACCOUNTS=default,alt1,work=/abs/dir
 *     `default` = the login Claude Code already uses (no CLAUDE_CONFIG_DIR override);
 *     `name` = `~/.claude-<name>`; `name=/path` = that directory.
 *     Fewer than two accounts = rotation off.
 *   OA_CLAUDE_ACCOUNT_SWITCH_AT=99   percent of a window that counts as spent.
 *
 * SECURITY: no token is ever read here. Only directory paths, percentages and
 * reset times are kept, and only names leave the server.
 */
import { cp, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ClaudeAccountsUsage, UsageLimitsSnapshot } from '@open-alive/core';

export const DEFAULT_ACCOUNT_NAME = 'default';
export const DEFAULT_SWITCH_AT_PERCENT = 99;
/** How long an account that hit its limit is benched when no reset time is known. */
const FALLBACK_BENCH_MS = 60 * 60_000;
/** 15 min, the same cadence as the header usage poll. */
const DEFAULT_POLL_MS = 15 * 60_000;

export interface ClaudeAccount {
  name: string;
  /** CLAUDE_CONFIG_DIR for this account; null = the login Claude Code already uses. */
  configDir: string | null;
}

export interface ClaudeAccountStatus {
  name: string;
  /** Unix ms until which the account is skipped; absent/past = usable. */
  limitedUntil?: number;
  /** Why it is skipped (CLI message or "5h 99%"). */
  limitedReason?: string;
  /** Highest 5h/7d utilization (0..1) from the latest `/usage` read. */
  utilization?: number;
  usageFetchedAt?: number;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/** Parse `OA_CLAUDE_ACCOUNTS`. Invalid or duplicate entries are dropped with a warning. */
export function parseClaudeAccounts(
  raw: string | undefined,
  home: string = homedir(),
  warn: (msg: string) => void = () => {},
): ClaudeAccount[] {
  if (!raw?.trim()) return [];
  const out: ClaudeAccount[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const name = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
    const path = eq >= 0 ? entry.slice(eq + 1).trim() : '';
    if (!NAME_RE.test(name)) {
      warn(`ignoring account "${name}": use letters, digits, _ . -`);
      continue;
    }
    if (out.some((a) => a.name === name)) {
      warn(`ignoring duplicate account "${name}"`);
      continue;
    }
    if (path && !isAbsolute(path)) {
      warn(`ignoring account "${name}": the directory must be an absolute path`);
      continue;
    }
    const configDir = path || (name === DEFAULT_ACCOUNT_NAME ? null : join(home, `.claude-${name}`));
    out.push({ name, configDir });
  }
  return out;
}

/** `OA_CLAUDE_ACCOUNT_SWITCH_AT` as a 0..1 fraction (default 0.99). */
export function parseSwitchThreshold(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n) || n <= 0 || n > 100) {
    return DEFAULT_SWITCH_AT_PERCENT / 100;
  }
  return n / 100;
}

/** The directory Claude Code uses with no override. */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
}

export type AccountUsageFetcher = (extraEnv: Record<string, string>) => Promise<UsageLimitsSnapshot | null>;

export interface ClaudeAccountPoolOptions {
  accounts: ClaudeAccount[];
  /** 0..1; a 5h or 7d window at or above it benches the account until reset. */
  threshold?: number;
  /** Persists benches across restarts. Omit in tests. */
  stateFile?: string;
  /** `/usage` reader run under an account's env. Omit to disable polling. */
  fetchUsage?: AccountUsageFetcher;
  now?: () => number;
  log?: (msg: string) => void;
  /** Directory the `default` account resolves to (for session transfer). */
  defaultConfigDir?: string;
}

interface Bench {
  until: number;
  reason: string;
  /** `usage` = benched by the threshold (cleared when usage drops); `refused` = the CLI refused a run (expires by time). */
  source: 'usage' | 'refused';
}

export class ClaudeAccountPool {
  readonly accounts: readonly ClaudeAccount[];
  readonly threshold: number;
  private readonly benches = new Map<string, Bench>();
  private readonly usage = new Map<string, { utilization: number; snapshot: UsageLimitsSnapshot }>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly stateFile?: string;
  private readonly fetchUsage?: AccountUsageFetcher;
  private readonly defaultConfigDir: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  constructor(options: ClaudeAccountPoolOptions) {
    this.accounts = Object.freeze([...options.accounts]);
    this.threshold = options.threshold ?? DEFAULT_SWITCH_AT_PERCENT / 100;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.stateFile = options.stateFile;
    this.fetchUsage = options.fetchUsage;
    this.defaultConfigDir = options.defaultConfigDir ?? defaultClaudeConfigDir();
    this.readState();
  }

  /** Rotation needs somewhere to rotate to. */
  get enabled(): boolean {
    return this.accounts.length >= 2;
  }

  private find(name: string | undefined): ClaudeAccount | undefined {
    if (name === undefined) return this.accounts.find((a) => a.configDir === null);
    return this.accounts.find((a) => a.name === name);
  }

  isUsable(name: string): boolean {
    const bench = this.benches.get(name);
    return !bench || bench.until <= this.now();
  }

  /**
   * Account for the next run. `current` is kept while it is usable (its prompt
   * cache is warm); otherwise the first usable account in configured order.
   * Undefined = rotation off, or every account is spent.
   */
  pick(current?: string): string | undefined {
    if (!this.enabled) return undefined;
    if (current && this.find(current) && this.isUsable(current)) return current;
    return this.accounts.find((a) => this.isUsable(a.name))?.name;
  }

  /** Env overrides that make a `claude` child run as `name`. */
  envFor(name: string | undefined): Record<string, string> {
    const dir = this.find(name)?.configDir;
    return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
  }

  /**
   * Bench an account that just refused a run. `name` undefined = the default
   * login (a ticket that started before rotation was configured).
   */
  markLimited(name: string | undefined, reason: string, resetsAt?: number | null): void {
    const account = this.find(name);
    if (!account) return;
    const until = resetsAt && resetsAt > this.now() ? resetsAt : this.now() + FALLBACK_BENCH_MS;
    const prev = this.benches.get(account.name);
    // Keep the later reset: a 7d bench must not be shortened by a 5h message.
    if (prev && prev.until >= until) return;
    this.benches.set(account.name, { until, reason, source: 'refused' });
    this.log(`[accounts] ${account.name} benched until ${new Date(until).toISOString()}: ${reason}`);
    this.writeState();
    this.emit();
    // The real reset time is in `/usage`; refine the guess in the background.
    if (!resetsAt) void this.refresh(account.name);
  }

  /** Feed a `/usage` reading for an account (the poll, or the header poller for `default`). */
  noteUsage(name: string, snapshot: UsageLimitsSnapshot | null): void {
    if (!snapshot || snapshot.stale) return;
    const windows = [
      { label: '5h', w: snapshot.fiveHour },
      { label: '7d', w: snapshot.sevenDay },
    ].filter((x): x is { label: string; w: NonNullable<typeof x.w> } => x.w !== null);
    if (windows.length === 0) return;
    const top = Math.max(...windows.map((x) => x.w.utilization));
    this.usage.set(name, { utilization: top, snapshot });
    // Model-scoped weekly windows (e.g. one model's own cap) are left out: they
    // stop that model, not the account, and a run may use another model.
    const spent = windows.filter((x) => x.w.utilization >= this.threshold);
    if (spent.length > 0) {
      const resets = spent.map((x) => x.w.resetsAt ?? this.now() + FALLBACK_BENCH_MS);
      const until = Math.max(...resets);
      const reason = spent.map((x) => `${x.label} ${Math.round(x.w.utilization * 100)}%`).join(', ');
      const prev = this.benches.get(name);
      if (!prev || prev.until !== until) {
        this.benches.set(name, { until, reason, source: 'usage' });
        this.log(`[accounts] ${name} at ${reason} ≥ ${Math.round(this.threshold * 100)}%, skipped until ${new Date(until).toISOString()}`);
        this.writeState();
      }
    } else if (this.benches.get(name)?.source === 'usage') {
      // Below the threshold again (the window reset). A `refused` bench is left
      // to expire: the refusal may have come from a model-scoped cap that the
      // 5h/7d numbers do not show, and lifting it would bounce work back.
      this.benches.delete(name);
      this.log(`[accounts] ${name} usable again (${Math.round(top * 100)}%)`);
      this.writeState();
    }
    this.emit();
  }

  /** Called whenever an account's usage or availability changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.scheduleExpiry();
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.scheduleExpiry();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // a broken consumer must not stop the pool
      }
    }
  }

  /**
   * A bench that runs out changes which account is active with no other event,
   * so wake up then and tell listeners (only while someone is listening).
   */
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.listeners.size === 0) return;
    const upcoming = [...this.benches.values()].map((b) => b.until).filter((u) => u > this.now());
    if (upcoming.length === 0) return;
    // setTimeout caps at ~24.8 days; a longer wait simply re-arms on the next event.
    const wait = Math.min(Math.min(...upcoming) - this.now() + 1_000, 2 ** 31 - 1);
    this.expiryTimer = setTimeout(() => this.emit(), wait);
    this.expiryTimer.unref?.();
  }

  /** Every account's last `/usage` read and availability, for the header. Null when rotation is off. */
  usageSummary(): ClaudeAccountsUsage | null {
    if (!this.enabled) return null;
    return {
      active: this.pick() ?? null,
      threshold: this.threshold,
      accounts: this.accounts.map((a) => {
        const snap = this.usage.get(a.name)?.snapshot;
        const bench = this.benches.get(a.name);
        return {
          name: a.name,
          fiveHour: snap?.fiveHour ?? null,
          sevenDay: snap?.sevenDay ?? null,
          scopedWeekly: snap?.scopedWeekly ?? [],
          fetchedAt: snap?.fetchedAt ?? 0,
          ...(bench && bench.until > this.now() ? { limitedUntil: bench.until, limitedReason: bench.reason } : {}),
        };
      }),
    };
  }

  /** Read `/usage` for one account, or all non-default ones. */
  async refresh(only?: string): Promise<void> {
    if (!this.fetchUsage) return;
    const targets = this.accounts.filter((a) => (only ? a.name === only : a.configDir !== null));
    for (const account of targets) {
      const snap = await this.fetchUsage(this.envFor(account.name)).catch(() => null);
      this.noteUsage(account.name, snap);
    }
  }

  /**
   * Poll `/usage` for the non-default accounts. The default account is fed by
   * the header poller (see index.ts), so it is not asked twice.
   */
  start(intervalMs: number = DEFAULT_POLL_MS): void {
    if (!this.enabled || !this.fetchUsage || this.timer) return;
    const tick = () => {
      if (this.polling) return;
      this.polling = true;
      void this.refresh().finally(() => {
        this.polling = false;
      });
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  status(): ClaudeAccountStatus[] {
    return this.accounts.map((a) => {
      const bench = this.benches.get(a.name);
      const usage = this.usage.get(a.name);
      return {
        name: a.name,
        ...(bench && bench.until > this.now() ? { limitedUntil: bench.until, limitedReason: bench.reason } : {}),
        ...(usage ? { utilization: usage.utilization, usageFetchedAt: usage.snapshot.fetchedAt } : {}),
      };
    });
  }

  /**
   * Make a session written under `from` resumable under `to`. Claude Code keeps
   * transcripts in `<configDir>/projects/<cwd-slug>/<id>.jsonl`; when the two
   * accounts share `projects/` (a symlink, as `open-alive account add` sets up)
   * there is nothing to do. Otherwise the transcript (and its `<id>/` folder of
   * subagent transcripts) is copied when the target lacks it or holds an older copy.
   */
  async transferSession(sessionId: string, from: string | undefined, to: string): Promise<void> {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return;
    const fromDir = this.dirOf(this.find(from));
    const toDir = this.dirOf(this.find(to));
    if (!fromDir || !toDir) return;
    const fromProjects = join(fromDir, 'projects');
    const toProjects = join(toDir, 'projects');
    const [a, b] = await Promise.all([realpath(fromProjects).catch(() => null), realpath(toProjects).catch(() => null)]);
    if (!a || a === b) return;
    let slugs: string[];
    try {
      slugs = await readdir(fromProjects);
    } catch {
      return;
    }
    for (const slug of slugs) {
      const src = join(fromProjects, slug, `${sessionId}.jsonl`);
      const srcStat = await stat(src).catch(() => null);
      if (!srcStat) continue;
      const dst = join(toProjects, slug, `${sessionId}.jsonl`);
      const dstStat = await stat(dst).catch(() => null);
      if (dstStat && dstStat.mtimeMs >= srcStat.mtimeMs) return;
      await mkdir(join(toProjects, slug), { recursive: true });
      await cp(src, dst, { preserveTimestamps: true });
      const subDir = join(fromProjects, slug, sessionId);
      if (await stat(subDir).then((s) => s.isDirectory()).catch(() => false)) {
        await cp(subDir, join(toProjects, slug, sessionId), { recursive: true, force: true, preserveTimestamps: true });
      }
      this.log(`[accounts] copied session ${sessionId} from ${from ?? DEFAULT_ACCOUNT_NAME} to ${to}`);
      return;
    }
  }

  /** True when the account has the account name. */
  has(name: string): boolean {
    return this.accounts.some((a) => a.name === name);
  }

  /** Whether `sessionId` has a transcript `--resume` can open under `account`. */
  async hasSession(sessionId: string, account: string | undefined): Promise<boolean> {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return false;
    const dir = this.dirOf(this.find(account));
    if (!dir) return false;
    const projects = join(dir, 'projects');
    let slugs: string[];
    try {
      slugs = await readdir(projects);
    } catch {
      return false;
    }
    for (const slug of slugs) {
      if (await stat(join(projects, slug, `${sessionId}.jsonl`)).then(() => true).catch(() => false)) return true;
    }
    return false;
  }

  private dirOf(account: ClaudeAccount | undefined): string | null {
    if (!account) return null;
    return account.configDir ?? this.defaultConfigDir;
  }

  private readState(): void {
    if (!this.stateFile) return;
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { benches?: Record<string, Bench> };
      for (const [name, bench] of Object.entries(parsed.benches ?? {})) {
        if (this.find(name) && typeof bench?.until === 'number' && bench.until > this.now()) {
          this.benches.set(name, {
            until: bench.until,
            reason: String(bench.reason ?? ''),
            source: bench.source === 'usage' ? 'usage' : 'refused',
          });
        }
      }
    } catch {
      // no state yet
    }
  }

  private writeState(): void {
    if (!this.stateFile) return;
    try {
      writeFileSync(this.stateFile, JSON.stringify({ benches: Object.fromEntries(this.benches) }), { mode: 0o600 });
    } catch {
      // losing the bench only costs one more refused run after a restart
    }
  }
}
