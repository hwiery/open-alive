/**
 * Codex subscription usage, read from Codex's own session logs.
 *
 * After every turn Codex appends a `token_count` event carrying its current
 * `rate_limits` (used percent, window length, reset time) to the session file
 * under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. The newest such event
 * is the latest known usage — no network call, no credentials. The numbers are
 * as fresh as the last Codex run; `observedAt` carries that time.
 *
 * The logs only see turns run on this machine, so usage from elsewhere (another
 * computer, Codex cloud) is missing until Codex runs here again. A slow second
 * source asks Codex itself: `codex app-server`'s `account/rateLimits/read`,
 * under Codex's own login. Whichever reading is newer wins.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { augmentPath, type CodexUsage, type UsageWindow } from '@open-alive/core';
import { createCodexSupervisor, type CodexSupervisor } from '../codexSupervisor.js';

/** Read at most this much from the end of the newest log. */
const TAIL_BYTES = 512 * 1024;

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/** Newest entry of a directory by name (the date folders and rollout names sort chronologically). */
async function newest(dir: string, filter: (name: string) => boolean): Promise<string | null> {
  try {
    const names = (await readdir(dir)).filter(filter).sort();
    return names.length > 0 ? join(dir, names[names.length - 1]!) : null;
  } catch {
    return null;
  }
}

async function newestSessionFile(home: string): Promise<string | null> {
  let dir: string | null = join(home, 'sessions');
  for (let depth = 0; depth < 3 && dir; depth += 1) dir = await newest(dir, (n) => /^\d+$/.test(n));
  return dir ? newest(dir, (n) => n.endsWith('.jsonl')) : null;
}

async function readTail(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf-8');
  } finally {
    await handle.close();
  }
}

type RawWindow = { used?: unknown; minutes?: unknown; resetsAt?: unknown };
type Placed = { minutes: number; window: UsageWindow };

function toWindow(w: RawWindow): Placed | null {
  if (typeof w.used !== 'number' || !Number.isFinite(w.used)) return null;
  const minutes = typeof w.minutes === 'number' ? w.minutes : 0;
  const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null;
  return { minutes, window: { utilization: w.used / 100, resetsAt } };
}

/** Log events spell the window in snake_case. */
function logWindow(raw: unknown): Placed | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
  return toWindow({ used: w.used_percent, minutes: w.window_minutes, resetsAt: w.resets_at });
}

/** The app-server spells it in camelCase. */
function rpcWindow(raw: unknown): Placed | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
  return toWindow({ used: w.usedPercent, minutes: w.windowDurationMins, resetsAt: w.resetsAt });
}

/**
 * Windows are placed by their length (≤ 1 day → 5-hour slot, otherwise
 * weekly), not by whether Codex calls them primary or secondary — that
 * assignment varies by plan.
 */
function place(windows: Array<Placed | null>, observedAt: number): CodexUsage | null {
  const usable = windows.filter((w) => w !== null);
  if (usable.length === 0) return null;
  const short = usable.find((w) => w.minutes > 0 && w.minutes <= 1440)?.window ?? null;
  const long = usable.find((w) => w.minutes > 1440)?.window ?? null;
  return { fiveHour: short, sevenDay: long, observedAt };
}

/** The latest rate limits in a chunk of Codex JSONL, or null. */
export function parseCodexRateLimits(text: string, fallbackObservedAt: number): CodexUsage | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    let event: { timestamp?: unknown; payload?: { rate_limits?: unknown }; rate_limits?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue; // the tail can start mid-line
    }
    const limits = (event.payload?.rate_limits ?? event.rate_limits) as { primary?: unknown; secondary?: unknown } | null | undefined;
    if (!limits || typeof limits !== 'object') continue;
    const ts = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
    const usage = place([logWindow(limits.primary), logWindow(limits.secondary)], Number.isFinite(ts) ? ts : fallbackObservedAt);
    if (usage) return usage;
  }
  return null;
}

/** Latest Codex usage on this machine, or null when there is none. */
export async function readCodexUsage(home: string = codexHome()): Promise<CodexUsage | null> {
  const file = await newestSessionFile(home);
  if (!file) return null;
  try {
    const [text, info] = await Promise.all([readTail(file), stat(file)]);
    return parseCodexRateLimits(text, info.mtimeMs);
  } catch {
    return null;
  }
}

/** An `account/rateLimits/read` result as usage observed at `observedAt`, or null. */
export function parseCodexRateLimitsResult(result: unknown, observedAt: number): CodexUsage | null {
  const limits = (result as { rateLimits?: unknown } | null)?.rateLimits as { primary?: unknown; secondary?: unknown } | null | undefined;
  if (!limits || typeof limits !== 'object') return null;
  return place([rpcWindow(limits.primary), rpcWindow(limits.secondary)], observedAt);
}

/** The newer of two readings; either may be missing. */
export function newerCodexUsage(a: CodexUsage | null, b: CodexUsage | null): CodexUsage | null {
  if (!a) return b;
  if (!b) return a;
  return b.observedAt > a.observedAt ? b : a;
}

const LIVE_TIMEOUT_MS = 15_000;

/**
 * Ask Codex for the account's current usage: a short-lived `codex app-server`,
 * one request, then stopped. Null when Codex is missing, logged out or slow —
 * the logs still stand in then.
 */
export async function fetchCodexUsageLive(
  createSupervisor: () => CodexSupervisor = () =>
    createCodexSupervisor({ requestTimeoutMs: LIVE_TIMEOUT_MS, env: { ...process.env, PATH: augmentPath(process.env.PATH) } }),
  now: () => number = Date.now,
): Promise<CodexUsage | null> {
  let supervisor: CodexSupervisor;
  try {
    supervisor = createSupervisor();
  } catch {
    return null; // not installed
  }
  try {
    await supervisor.start();
    return parseCodexRateLimitsResult(await supervisor.request('account/rateLimits/read'), now());
  } catch {
    return null;
  } finally {
    supervisor.stop();
  }
}
