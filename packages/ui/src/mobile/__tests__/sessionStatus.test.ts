import { describe, it, expect } from 'vitest';
import type { AgentState } from '@open-alive/core';
import { sessionStatus, splitSessions, relativeTime } from '../sessionStatus.ts';
import type { MobileSession } from '../MobileSessionList.tsx';

const session = (over: Partial<MobileSession>): MobileSession => ({
  sessionId: 'cat-1', providerSessionId: 'claude-1', displayName: 'x', state: 'starting',
  cwd: '/w/app', lastActivityAt: 1000, needsApproval: false, ...over,
});

const live = (entries: Array<[string, AgentState]>) => new Map<string, AgentState>(entries);

describe('sessionStatus', () => {
  it('follows the PC: a session the PC no longer runs is ended, whatever the catalog says', () => {
    // The catalog still reads `starting` for sessions whose end it never saw.
    expect(sessionStatus(session({ state: 'starting' }), live([]))).toBe('ended');
    expect(sessionStatus(session({ state: 'stopped' }), live([['claude-1', 'active']]))).toBe('working');
  });

  it('maps the PC agent state to what the phone needs to know', () => {
    const cases: Array<[AgentState, string]> = [
      ['active', 'working'], ['waiting', 'waiting'], ['listening', 'idle'], ['idle', 'idle'],
      ['spawning', 'starting'], ['error', 'error'], ['done', 'ended'], ['despawning', 'ended'], ['removed', 'ended'],
    ];
    for (const [state, want] of cases) expect(sessionStatus(session({}), live([['claude-1', state]])), state).toBe(want);
  });

  it('puts a pending approval above everything else on a live session', () => {
    expect(sessionStatus(session({ needsApproval: true }), live([['claude-1', 'active']]))).toBe('approval');
    // An ended session cannot be approved any more.
    expect(sessionStatus(session({ needsApproval: true }), live([]))).toBe('ended');
  });

  it('falls back to the catalog state while the PC list is unknown (offline)', () => {
    expect(sessionStatus(session({ state: 'using-tool' }), null)).toBe('working');
    expect(sessionStatus(session({ state: 'waiting-user' }), null)).toBe('waiting');
    expect(sessionStatus(session({ state: 'ready' }), null)).toBe('idle');
    expect(sessionStatus(session({ state: 'stopped' }), null)).toBe('ended');
    expect(sessionStatus(session({ state: 'failed' }), null)).toBe('ended');
  });
});

describe('splitSessions', () => {
  it('keeps ended sessions apart, newest first, and blocked live ones on top', () => {
    const rows = [
      session({ sessionId: 'a', providerSessionId: 'pa', lastActivityAt: 50 }),
      session({ sessionId: 'b', providerSessionId: 'pb', lastActivityAt: 90 }),
      session({ sessionId: 'c', providerSessionId: 'pc', lastActivityAt: 10 }),
      session({ sessionId: 'd', providerSessionId: 'pd', lastActivityAt: 70 }),
    ];
    const { active, ended } = splitSessions(rows, live([['pa', 'active'], ['pc', 'waiting']]));
    expect(active.map((r) => r.session.sessionId)).toEqual(['c', 'a']);
    expect(active.map((r) => r.status)).toEqual(['waiting', 'working']);
    expect(ended.map((r) => r.session.sessionId)).toEqual(['b', 'd']);
  });

  it('caps the ended list, not the live one', () => {
    const many = Array.from({ length: 100 }, (_, i) => session({ sessionId: `e${i}`, providerSessionId: `p${i}`, lastActivityAt: i }));
    const { ended } = splitSessions(many, live([]), 30);
    expect(ended).toHaveLength(30);
    expect(ended[0]!.session.sessionId).toBe('e99');
  });
});

describe('relativeTime', () => {
  const t = (key: string, opts?: { count?: number }) => `${key}:${opts?.count ?? ''}`;
  it('reads in the largest unit that fits', () => {
    const now = 10 * 86_400_000;
    expect(relativeTime(now, now - 500, t)).toBe('time.justNow:');
    expect(relativeTime(now, now - 5 * 60_000, t)).toBe('time.minutesAgo:5');
    expect(relativeTime(now, now - 3 * 3_600_000, t)).toBe('time.hoursAgo:3');
    expect(relativeTime(now, now - 2 * 86_400_000, t)).toBe('time.daysAgo:2');
    expect(relativeTime(now, 0, t)).toBe('');
  });
});
