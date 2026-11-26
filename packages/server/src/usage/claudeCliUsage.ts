/**
 * Claude subscription usage, asked of Claude Code itself: `claude -p /usage`.
 *
 * `/usage` is a local command — it makes no model call and costs nothing —
 * and it runs under Claude Code's own login, so token refreshes, keychain
 * layout changes, logout/login and account switches are all Claude Code's
 * business. The raw OAuth poll in rateLimitsPoller.ts broke when Claude Code
 * stopped keeping a readable access token in the keychain; this path does not
 * depend on where the credential lives.
 *
 * The child runs with no setting sources (so no user hooks fire and the call
 * never shows up as a session on the dashboard), no MCP servers, no session
 * file, and TZ=UTC so the printed reset times parse without a zone table.
 */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { augmentPath, type ScopedUsageWindow, type UsageLimitsSnapshot, type UsageWindow } from '@open-alive/core';

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT_MS = 60_000;
const CLI_ARGS = ['-p', '/usage', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 60 * 60_000;
/** A dated reset further back than this is read as next year's date. */
const PAST_TOLERANCE_MS = 180 * DAY_MS;

/** "resets Oct 25 at 12:59am (UTC)", "resets 4:29am (UTC)", "resets Oct 25 (UTC)" → unix ms. */
function parseReset(text: string, now: number): number | null {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:\s+at)?\s*)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i.exec(text);
  if (!m || (!m[1] && !m[3])) return null;
  let hour = m[3] ? Number(m[3]) % 12 : 0;
  if (m[5]?.toLowerCase() === 'pm') hour += 12;
  const minute = m[4] ? Number(m[4]) : 0;
  const today = new Date(now);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    const at = (year: number) => Date.UTC(year, month, Number(m[2]), hour, minute);
    const thisYear = at(today.getUTCFullYear());
    return thisYear < now - PAST_TOLERANCE_MS ? at(today.getUTCFullYear() + 1) : thisYear;
  }
  const sameDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hour, minute);
  return sameDay < now ? sameDay + DAY_MS : sameDay;
}

function windowOf(rest: string, pct: string, now: number): UsageWindow {
  return { utilization: Number(pct) / 100, resetsAt: parseReset(rest, now) };
}

/** Parse the `/usage` text (printed under TZ=UTC); null when it shows no window. */
export function parseClaudeUsageText(text: string, fetchedAt: number): UsageLimitsSnapshot | null {
  let fiveHour: UsageWindow | null = null;
  let sevenDay: UsageWindow | null = null;
  const scopedWeekly: ScopedUsageWindow[] = [];
  for (const line of text.split('\n')) {
    const session = /^\s*Current session:\s*(\d+(?:\.\d+)?)%(.*)$/i.exec(line);
    if (session) {
      fiveHour = windowOf(session[2]!, session[1]!, fetchedAt);
      continue;
    }
    const week = /^\s*Current week \(([^)]+)\):\s*(\d+(?:\.\d+)?)%(.*)$/i.exec(line);
    if (!week) continue;
    const window = windowOf(week[3]!, week[2]!, fetchedAt);
    if (week[1]!.toLowerCase() === 'all models') sevenDay = window;
    else scopedWeekly.push({ ...window, modelName: week[1]! });
  }
  if (!fiveHour && !sevenDay && scopedWeekly.length === 0) return null;
  return { fiveHour, sevenDay, scopedWeekly, fetchedAt, stale: false };
}

export type ClaudeCliRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const runClaude: ClaudeCliRunner = async (args, env) => {
  const { stdout } = await execFileAsync('claude', args, { env, cwd: tmpdir(), timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

/** Current usage from `claude -p /usage`; null when Claude Code is missing, logged out or fails. */
export async function fetchClaudeUsageViaCli(
  run: ClaudeCliRunner = runClaude,
  now: () => number = Date.now,
  extraEnv: Record<string, string> = {},
): Promise<UsageLimitsSnapshot | null> {
  try {
    // Launched from a Claude Code session the child would think it is nested.
    // `extraEnv` selects another account (CLAUDE_CONFIG_DIR, see claudeAccounts.ts).
    const { CLAUDECODE: _nested, ...inherited } = process.env;
    const env: NodeJS.ProcessEnv = { ...inherited, ...extraEnv, PATH: augmentPath(process.env.PATH), TZ: 'UTC' };
    const parsed = JSON.parse(await run(CLI_ARGS, env)) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const result = messages.find((m): m is { type: string; is_error?: unknown; result?: unknown } => m?.type === 'result');
    if (!result || result.is_error === true || typeof result.result !== 'string') return null;
    return parseClaudeUsageText(result.result, now());
  } catch {
    return null;
  }
}
