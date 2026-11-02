import { describe, it, expect } from 'vitest';
import { fetchClaudeUsageViaCli, parseClaudeUsageText } from '../claudeCliUsage.js';

/** Trimmed copy of a real `claude -p /usage` result, run with TZ=UTC. */
const REAL_TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 3% used · resets Oct 23 at 4:29am (UTC)',
  'Current week (all models): 86% used · resets Oct 25 at 12:59am (UTC)',
  'Current week (Fable): 44% used · resets Oct 25 at 12:59am (UTC)',
  '',
  "What's contributing to your limits usage?",
  'Last 24h · 2979 requests · 194 sessions',
  '  87%  Start fresh when you switch tasks · run /clear',
].join('\n');

const NOW = Date.parse('2026-10-23T01:04:00Z');

describe('parseClaudeUsageText', () => {
  it('reads session, weekly and model-scoped windows with UTC reset times', () => {
    const snap = parseClaudeUsageText(REAL_TEXT, NOW);
    expect(snap?.fiveHour).toEqual({ utilization: 0.03, resetsAt: Date.parse('2026-10-23T04:29:00Z') });
    expect(snap?.sevenDay).toEqual({ utilization: 0.86, resetsAt: Date.parse('2026-10-25T00:59:00Z') });
    expect(snap?.scopedWeekly).toEqual([
      { modelName: 'Fable', utilization: 0.44, resetsAt: Date.parse('2026-10-25T00:59:00Z') },
    ]);
    expect(snap?.fetchedAt).toBe(NOW);
    expect(snap?.stale).toBe(false);
  });

  it('does not take the contributor percentages for windows', () => {
    const snap = parseClaudeUsageText(REAL_TEXT, NOW);
    expect(snap?.scopedWeekly).toHaveLength(1);
  });

  it('rolls a reset date into the next year across new year', () => {
    const snap = parseClaudeUsageText('Current week (all models): 10% used · resets Jan 2 at 1am (UTC)', Date.parse('2026-12-30T00:00:00Z'));
    expect(snap?.sevenDay?.resetsAt).toBe(Date.parse('2027-01-02T01:00:00Z'));
  });

  it('reads a time-only reset as its next occurrence', () => {
    const snap = parseClaudeUsageText('Current session: 50% used · resets 12:30am (UTC)', Date.parse('2026-10-23T22:00:00Z'));
    expect(snap?.fiveHour?.resetsAt).toBe(Date.parse('2026-10-24T00:30:00Z'));
  });

  it('keeps the percentage when the reset time is missing or unreadable', () => {
    const snap = parseClaudeUsageText('Current session: 7% used', NOW);
    expect(snap?.fiveHour).toEqual({ utilization: 0.07, resetsAt: null });
  });

  it('returns null when no window is shown (logged out, API key)', () => {
    expect(parseClaudeUsageText('Not logged in · Please run /login', NOW)).toBeNull();
    expect(parseClaudeUsageText('', NOW)).toBeNull();
  });
});

describe('fetchClaudeUsageViaCli', () => {
  const result = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });

  it('runs claude without hooks or MCP, in UTC, and parses the result', async () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | null = null;
    const snap = await fetchClaudeUsageViaCli(async (args, env) => {
      seen = { args, env };
      return result(REAL_TEXT);
    }, () => NOW);
    expect(snap?.sevenDay?.utilization).toBeCloseTo(0.86);
    expect(seen!.args).toEqual(expect.arrayContaining(['-p', '/usage', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence']));
    expect(seen!.env.TZ).toBe('UTC');
  });

  it('returns null when claude is missing, fails, or prints something else', async () => {
    expect(await fetchClaudeUsageViaCli(async () => { throw new Error('ENOENT'); })).toBeNull();
    expect(await fetchClaudeUsageViaCli(async () => 'not json')).toBeNull();
    expect(await fetchClaudeUsageViaCli(async () => JSON.stringify({ type: 'result', is_error: true, result: REAL_TEXT }))).toBeNull();
  });
});
