import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCodexUsageLive, newerCodexUsage, parseCodexRateLimits, parseCodexRateLimitsResult, readCodexUsage } from '../codexUsage.js';
import type { CodexSupervisor } from '../../codexSupervisor.js';

const event = (limits: unknown, ts = '2026-10-14T02:28:19.253Z') =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: limits } });

describe('parseCodexRateLimits', () => {
  it('places windows by length and converts resets to ms', () => {
    const text = [
      event({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1 } }, '2026-10-14T01:00:00Z'),
      '{"type":"turn.started"}',
      event({ primary: { used_percent: 13, window_minutes: 10080, resets_at: 1792472301 }, secondary: { used_percent: 40, window_minutes: 300, resets_at: 1792400000 } }),
    ].join('\n');
    expect(parseCodexRateLimits(text, 0)).toEqual({
      fiveHour: { utilization: 0.4, resetsAt: 1792400000000 },
      sevenDay: { utilization: 0.13, resetsAt: 1792472301000 },
      observedAt: Date.parse('2026-10-14T02:28:19.253Z'),
    });
  });

  it('skips a cut-off first line and events without usable windows', () => {
    const text = ['ate_limits":{"primary"', event({ primary: null, secondary: null })].join('\n');
    expect(parseCodexRateLimits(text, 0)).toBeNull();
  });
});

describe('readCodexUsage', () => {
  it('reads the newest session log under sessions/YYYY/MM/DD', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    try {
      const old = join(home, 'sessions', '2026', '09', '30');
      const recent = join(home, 'sessions', '2026', '10', '14');
      await mkdir(old, { recursive: true });
      await mkdir(recent, { recursive: true });
      await writeFile(join(old, 'rollout-a.jsonl'), event({ primary: { used_percent: 99, window_minutes: 10080 } }) + '\n');
      await writeFile(join(recent, 'rollout-b.jsonl'), event({ primary: { used_percent: 13, window_minutes: 10080 } }) + '\n');
      expect((await readCodexUsage(home))?.sevenDay?.utilization).toBe(0.13);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('is null without a Codex install', async () => {
    expect(await readCodexUsage(join(tmpdir(), 'no-codex-here-oa'))).toBeNull();
  });
});

// The shape codex-cli 0.148.0 returned for `account/rateLimits/read` (2026-10-16).
const liveResult = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1792649598 },
    secondary: null,
    planType: 'pro',
  },
};

function fakeSupervisor(reply: () => Promise<Record<string, unknown>>) {
  const calls: string[] = [];
  const supervisor = {
    start: async () => { calls.push('start'); return {}; },
    request: async (method: string) => { calls.push(method); return reply(); },
    stop: () => { calls.push('stop'); },
  } as unknown as CodexSupervisor;
  return { supervisor, calls };
}

describe('parseCodexRateLimitsResult', () => {
  it('reads the camelCase app-server windows', () => {
    expect(parseCodexRateLimitsResult(liveResult, 42)).toEqual({
      fiveHour: null,
      sevenDay: { utilization: 0.24, resetsAt: 1792649598000 },
      observedAt: 42,
    });
  });

  it('is null without usable windows', () => {
    expect(parseCodexRateLimitsResult({ rateLimits: { primary: null, secondary: null } }, 0)).toBeNull();
    expect(parseCodexRateLimitsResult({}, 0)).toBeNull();
  });
});

describe('newerCodexUsage', () => {
  const at = (observedAt: number) => ({ fiveHour: null, sevenDay: null, observedAt });
  it('keeps the newer reading, either may be missing', () => {
    expect(newerCodexUsage(at(1), at(2))).toEqual(at(2));
    expect(newerCodexUsage(at(3), at(2))).toEqual(at(3));
    expect(newerCodexUsage(null, at(2))).toEqual(at(2));
    expect(newerCodexUsage(at(1), null)).toEqual(at(1));
  });
});

describe('fetchCodexUsageLive', () => {
  it('handshakes, reads the limits, and stops the process', async () => {
    const { supervisor, calls } = fakeSupervisor(async () => liveResult);
    const usage = await fetchCodexUsageLive(() => supervisor, () => 7);
    expect(usage?.sevenDay?.utilization).toBe(0.24);
    expect(usage?.observedAt).toBe(7);
    expect(calls).toEqual(['start', 'account/rateLimits/read', 'stop']);
  });

  it('is null and still stops when the request fails', async () => {
    const { supervisor, calls } = fakeSupervisor(async () => { throw new Error('not logged in'); });
    expect(await fetchCodexUsageLive(() => supervisor)).toBeNull();
    expect(calls.at(-1)).toBe('stop');
  });

  it('is null when Codex is not installed', async () => {
    expect(await fetchCodexUsageLive(() => { throw new Error('codex not found on PATH'); })).toBeNull();
  });
});
