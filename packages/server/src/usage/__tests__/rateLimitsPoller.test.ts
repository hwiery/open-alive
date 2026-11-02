import { describe, it, expect, vi } from 'vitest';
import { parseUsageResponse, UsageLimitsPoller } from '../rateLimitsPoller.js';

// Never spawn the real `claude` here; the token path is what these tests drive.
vi.mock('../claudeCliUsage.js', () => ({ fetchClaudeUsageViaCli: async () => null }));

/** Trimmed copy of a real `/api/oauth/usage` 200 body. */
const REAL_BODY = {
  five_hour: { utilization: 5.0, resets_at: '2026-09-02T15:39:59.510400+00:00' },
  seven_day: { utilization: 7.0, resets_at: '2026-09-06T00:59:59.510421+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 5, resets_at: '2026-09-02T15:39:59.510400+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 7, resets_at: '2026-09-06T00:59:59.510421+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 12,
      resets_at: null,
      scope: { model: { id: null, display_name: 'Fable' } },
    },
  ],
};

describe('parseUsageResponse', () => {
  it('reads the 5-hour and 7-day windows as 0..1 fractions', () => {
    const snap = parseUsageResponse(REAL_BODY, 1000);
    expect(snap?.fiveHour).toEqual({
      utilization: 0.05,
      resetsAt: Date.parse('2026-09-02T15:39:59.510400+00:00'),
    });
    expect(snap?.sevenDay?.utilization).toBeCloseTo(0.07);
    expect(snap?.fetchedAt).toBe(1000);
    expect(snap?.stale).toBe(false);
  });

  it('extracts model-scoped weekly windows with their display name', () => {
    const snap = parseUsageResponse(REAL_BODY, 0);
    expect(snap?.scopedWeekly).toEqual([{ modelName: 'Fable', utilization: 0.12, resetsAt: null }]);
  });

  it('falls back to limits[] when the top-level windows are absent', () => {
    const snap = parseUsageResponse({ limits: REAL_BODY.limits }, 0);
    expect(snap?.fiveHour?.utilization).toBeCloseTo(0.05);
    expect(snap?.sevenDay?.utilization).toBeCloseTo(0.07);
  });

  it('returns null for a body carrying no usable window', () => {
    expect(parseUsageResponse({ five_hour: null, seven_day: null, limits: [] }, 0)).toBeNull();
    expect(parseUsageResponse(null, 0)).toBeNull();
    expect(parseUsageResponse('nope', 0)).toBeNull();
  });

  it('ignores windows with a non-numeric utilization rather than emitting NaN', () => {
    const snap = parseUsageResponse(
      { five_hour: { utilization: 'x', resets_at: null }, seven_day: { utilization: 40 } },
      0,
    );
    expect(snap?.fiveHour).toBeNull();
    expect(snap?.sevenDay?.utilization).toBeCloseTo(0.4);
  });
});

describe('UsageLimitsPoller', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

  it('publishes a parsed snapshot to subscribers', async () => {
    const poller = new UsageLimitsPoller({
      intervalMs: 60_000,
      readToken: async () => 'tok',
      fetchImpl: async () => ok(REAL_BODY),
    });
    const seen: unknown[] = [];
    poller.subscribe((s) => seen.push(s));
    await poller.pollOnce();
    expect(seen).toHaveLength(1);
    expect(poller.latest()?.fiveHour?.utilization).toBeCloseTo(0.05);
  });

  it('keeps the last snapshot and marks it stale when a poll fails', async () => {
    let fail = false;
    const poller = new UsageLimitsPoller({
      readToken: async () => 'tok',
      fetchImpl: async () => {
        if (fail) throw new Error('network down');
        return ok(REAL_BODY);
      },
    });
    await poller.pollOnce();
    fail = true;
    await poller.pollOnce();

    const latest = poller.latest();
    expect(latest?.stale).toBe(true);
    expect(latest?.fiveHour?.utilization).toBeCloseTo(0.05);
  });

  it('backs off after a 429 instead of polling every minute, keeping the values', async () => {
    let clock = 0;
    let calls = 0;
    let limited = false;
    const poller = new UsageLimitsPoller({
      readToken: async () => 'tok',
      now: () => clock,
      fetchImpl: async () => {
        calls += 1;
        return limited ? ({ ok: false, status: 429, json: async () => ({}) } as Response) : ok(REAL_BODY);
      },
    });
    await poller.pollOnce();
    limited = true;
    await poller.pollOnce(); // 429 → wait 2 min
    expect(poller.latest()?.fiveHour?.utilization).toBeCloseTo(0.05);
    clock += 60_000;
    await poller.pollOnce();
    expect(calls).toBe(2); // skipped while backing off
    clock += 61_000;
    await poller.pollOnce(); // second 429 → wait 4 min
    expect(calls).toBe(3);
    clock += 3 * 60_000;
    await poller.pollOnce();
    expect(calls).toBe(3);
    limited = false;
    clock += 61_000;
    await poller.pollOnce();
    expect(calls).toBe(4);
    expect(poller.latest()?.stale).toBe(false);
  });

  it('restores the last snapshot from its cache file after a restart', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'usage-cache-'));
    const cacheFile = join(dir, 'usage-cache.json');
    try {
      const first = new UsageLimitsPoller({ cacheFile, readToken: async () => 'tok', fetchImpl: async () => ok(REAL_BODY) });
      await first.pollOnce();
      const restarted = new UsageLimitsPoller({ cacheFile, readToken: async () => null });
      expect(restarted.latest()?.sevenDay?.utilization).toBeCloseTo(0.07);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks stale on a 401 instead of dropping the values', async () => {
    let unauthorized = false;
    const poller = new UsageLimitsPoller({
      readToken: async () => 'tok',
      fetchImpl: async () =>
        unauthorized ? ({ ok: false, status: 401, json: async () => ({}) } as Response) : ok(REAL_BODY),
    });
    await poller.pollOnce();
    unauthorized = true;
    await poller.pollOnce();
    expect(poller.latest()?.stale).toBe(true);
  });

  it('publishes an empty stale snapshot when nothing was ever fetched, without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const poller = new UsageLimitsPoller({ readToken: async () => null, fetchImpl });
    await poller.pollOnce();
    expect(poller.latest()).toEqual({ fiveHour: null, sevenDay: null, scopedWeekly: [], fetchedAt: 0, stale: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('marks stale while backing off after a 429', async () => {
    const poller = new UsageLimitsPoller({
      readToken: async () => 'tok',
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response,
    });
    await poller.pollOnce();
    expect(poller.latest()?.stale).toBe(true);
  });

  it('re-reads the token on every poll so a refreshed credential is picked up', async () => {
    const tokens = ['old', 'new'];
    const used: string[] = [];
    const poller = new UsageLimitsPoller({
      readToken: async () => tokens.shift() ?? null,
      fetchImpl: async (_url, init) => {
        used.push(String((init?.headers as Record<string, string>)?.Authorization));
        return ok(REAL_BODY);
      },
    });
    await poller.pollOnce();
    await poller.pollOnce();
    expect(used).toEqual(['Bearer old', 'Bearer new']);
  });
});

describe('UsageLimitsPoller CLI source', () => {
  const cliSnap = { fiveHour: null, sevenDay: { utilization: 0.86, resetsAt: null }, scopedWeekly: [], fetchedAt: 5, stale: false };

  it('prefers Claude Code /usage and skips the token endpoint', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => REAL_BODY }) as Response);
    const poller = new UsageLimitsPoller({ readCli: async () => cliSnap, readToken: async () => 'tok', fetchImpl });
    await poller.pollOnce();
    expect(poller.latest()?.sevenDay?.utilization).toBeCloseTo(0.86);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the token endpoint when the CLI yields nothing', async () => {
    const poller = new UsageLimitsPoller({
      readCli: async () => null,
      readToken: async () => 'tok',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => REAL_BODY }) as Response,
    });
    await poller.pollOnce();
    expect(poller.latest()?.sevenDay?.utilization).toBeCloseTo(0.07);
  });

  it('still reads the CLI while the token endpoint is backing off after a 429', async () => {
    let cli: typeof cliSnap | null = null;
    const poller = new UsageLimitsPoller({
      readCli: async () => cli,
      readToken: async () => 'tok',
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response,
    });
    await poller.pollOnce();
    cli = cliSnap;
    await poller.pollOnce();
    expect(poller.latest()?.sevenDay?.utilization).toBeCloseTo(0.86);
  });
});
