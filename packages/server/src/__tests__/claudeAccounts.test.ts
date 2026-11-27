import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageLimitsSnapshot } from '@open-alive/core';
import { ClaudeAccountPool, parseClaudeAccounts, parseSwitchThreshold } from '../claudeAccounts.js';

const HOME = '/home/tester';

function snap(fiveHour: number, sevenDay: number, resetsAt: number | null = 10_000): UsageLimitsSnapshot {
  return {
    fiveHour: { utilization: fiveHour, resetsAt },
    sevenDay: { utilization: sevenDay, resetsAt: resetsAt === null ? null : resetsAt * 2 },
    scopedWeekly: [],
    fetchedAt: 1,
    stale: false,
  };
}

describe('parseClaudeAccounts', () => {
  it('maps default, bare names and explicit dirs', () => {
    expect(parseClaudeAccounts('default, alt1 ,work=/abs/dir', HOME)).toEqual([
      { name: 'default', configDir: null },
      { name: 'alt1', configDir: `${HOME}/.claude-alt1` },
      { name: 'work', configDir: '/abs/dir' },
    ]);
  });

  it('drops invalid, duplicate and relative entries', () => {
    const warnings: string[] = [];
    const out = parseClaudeAccounts('a,a,../x,b=rel/dir,c', HOME, (m) => warnings.push(m));
    expect(out.map((a) => a.name)).toEqual(['a', 'c']);
    expect(warnings).toHaveLength(3);
  });

  it('is empty when unset', () => {
    expect(parseClaudeAccounts(undefined)).toEqual([]);
    expect(parseClaudeAccounts('  ')).toEqual([]);
  });
});

describe('parseSwitchThreshold', () => {
  it('defaults to 99%', () => {
    expect(parseSwitchThreshold(undefined)).toBe(0.99);
    expect(parseSwitchThreshold('abc')).toBe(0.99);
    expect(parseSwitchThreshold('0')).toBe(0.99);
    expect(parseSwitchThreshold('150')).toBe(0.99);
  });
  it('reads a percentage', () => {
    expect(parseSwitchThreshold('90')).toBe(0.9);
    expect(parseSwitchThreshold('100')).toBe(1);
  });
});

describe('ClaudeAccountPool', () => {
  let clock = 1_000;
  const now = () => clock;
  const accounts = parseClaudeAccounts('default,alt1,alt2', HOME);

  beforeEach(() => {
    clock = 1_000;
  });

  it('is off with fewer than two accounts', () => {
    const pool = new ClaudeAccountPool({ accounts: accounts.slice(0, 1), now });
    expect(pool.enabled).toBe(false);
    expect(pool.pick()).toBeUndefined();
  });

  it('picks in order and keeps a usable current account', () => {
    const pool = new ClaudeAccountPool({ accounts, now });
    expect(pool.pick()).toBe('default');
    expect(pool.pick('alt2')).toBe('alt2');
    expect(pool.pick('gone')).toBe('default');
  });

  it('sets CLAUDE_CONFIG_DIR only for non-default accounts', () => {
    const pool = new ClaudeAccountPool({ accounts, now });
    expect(pool.envFor('default')).toEqual({});
    expect(pool.envFor('alt1')).toEqual({ CLAUDE_CONFIG_DIR: `${HOME}/.claude-alt1` });
  });

  it('benches a refused account until the fallback hour passes', () => {
    const pool = new ClaudeAccountPool({ accounts, now });
    pool.markLimited('default', 'hit your limit');
    expect(pool.pick()).toBe('alt1');
    expect(pool.pick('default')).toBe('alt1');
    clock += 60 * 60_000;
    expect(pool.pick()).toBe('default');
  });

  it('treats an undefined account as the default login', () => {
    const pool = new ClaudeAccountPool({ accounts, now });
    pool.markLimited(undefined, 'hit your limit');
    expect(pool.isUsable('default')).toBe(false);
  });

  it('returns undefined when every account is spent', () => {
    const pool = new ClaudeAccountPool({ accounts, now });
    for (const a of accounts) pool.markLimited(a.name, 'x');
    expect(pool.pick()).toBeUndefined();
  });

  it('skips an account at the threshold until its window resets, and lifts it below', () => {
    const pool = new ClaudeAccountPool({ accounts, threshold: 0.99, now });
    pool.noteUsage('default', snap(0.98, 0.5));
    expect(pool.pick()).toBe('default');
    pool.noteUsage('default', snap(0.99, 0.5, 50_000));
    expect(pool.pick()).toBe('alt1');
    expect(pool.status()[0]).toMatchObject({ name: 'default', limitedUntil: 50_000 });
    pool.noteUsage('default', snap(0.1, 0.5));
    expect(pool.pick()).toBe('default');
  });

  it('uses the later reset when both windows are spent', () => {
    const pool = new ClaudeAccountPool({ accounts, now });
    pool.noteUsage('alt1', snap(1, 1, 20_000));
    expect(pool.status()[1]!.limitedUntil).toBe(40_000);
  });

  it('does not lift a refusal because 5h/7d look fine (model-scoped caps)', () => {
    const pool = new ClaudeAccountPool({ accounts, now });
    pool.markLimited('default', 'hit your opus limit');
    pool.noteUsage('default', snap(0.2, 0.2));
    expect(pool.isUsable('default')).toBe(false);
  });

  it('ignores stale or empty usage', () => {
    const pool = new ClaudeAccountPool({ accounts, now });
    pool.noteUsage('default', { ...snap(1, 1), stale: true });
    pool.noteUsage('default', null);
    expect(pool.isUsable('default')).toBe(true);
  });

  it('refreshes non-default accounts through their own env', async () => {
    const seen: Record<string, string>[] = [];
    const pool = new ClaudeAccountPool({
      accounts,
      now,
      fetchUsage: async (env) => {
        seen.push(env);
        return env.CLAUDE_CONFIG_DIR?.endsWith('alt1') ? snap(1, 0.1, 99_000) : snap(0.1, 0.1);
      },
    });
    await pool.refresh();
    expect(seen).toEqual([{ CLAUDE_CONFIG_DIR: `${HOME}/.claude-alt1` }, { CLAUDE_CONFIG_DIR: `${HOME}/.claude-alt2` }]);
    expect(pool.isUsable('alt1')).toBe(false);
    expect(pool.isUsable('alt2')).toBe(true);
  });

  describe('state file and session transfer', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'oa-accounts-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('keeps benches across a restart', () => {
      const stateFile = join(dir, 'state.json');
      new ClaudeAccountPool({ accounts, now, stateFile }).markLimited('alt1', 'x');
      const again = new ClaudeAccountPool({ accounts, now, stateFile });
      expect(again.isUsable('alt1')).toBe(false);
    });

    const sid = '0f3c2b1a-1111-2222-3333-444455556666';

    function pool() {
      return new ClaudeAccountPool({
        accounts: [
          { name: 'default', configDir: null },
          { name: 'alt1', configDir: join(dir, 'alt1') },
        ],
        defaultConfigDir: join(dir, 'main'),
        now,
      });
    }

    it('copies the transcript and its subagent folder to the target account', async () => {
      const slug = '-repo-x';
      await mkdir(join(dir, 'main/projects', slug, sid, 'subagents'), { recursive: true });
      await writeFile(join(dir, 'main/projects', slug, `${sid}.jsonl`), '{"a":1}\n');
      await writeFile(join(dir, 'main/projects', slug, sid, 'subagents/agent-1.jsonl'), 'sub\n');
      await mkdir(join(dir, 'alt1/projects'), { recursive: true });

      await pool().transferSession(sid, 'default', 'alt1');
      expect(await readFile(join(dir, 'alt1/projects', slug, `${sid}.jsonl`), 'utf8')).toBe('{"a":1}\n');
      expect(await readFile(join(dir, 'alt1/projects', slug, sid, 'subagents/agent-1.jsonl'), 'utf8')).toBe('sub\n');
    });

    it('does not overwrite a newer copy, but refreshes an older one', async () => {
      const slug = '-repo-y';
      await mkdir(join(dir, 'main/projects', slug), { recursive: true });
      await mkdir(join(dir, 'alt1/projects', slug), { recursive: true });
      const src = join(dir, 'main/projects', slug, `${sid}.jsonl`);
      const dst = join(dir, 'alt1/projects', slug, `${sid}.jsonl`);
      await writeFile(src, 'source\n');
      await writeFile(dst, 'newer-target\n');
      await utimes(src, 1_000, 1_000);
      await utimes(dst, 2_000, 2_000);
      await pool().transferSession(sid, 'default', 'alt1');
      expect(await readFile(dst, 'utf8')).toBe('newer-target\n');

      await utimes(src, 3_000, 3_000);
      await pool().transferSession(sid, 'default', 'alt1');
      expect(await readFile(dst, 'utf8')).toBe('source\n');
    });

    it('does nothing when projects/ is shared via symlink', async () => {
      await mkdir(join(dir, 'main/projects/-r'), { recursive: true });
      await writeFile(join(dir, 'main/projects/-r', `${sid}.jsonl`), 'x\n');
      await mkdir(join(dir, 'alt1'), { recursive: true });
      await symlink(join(dir, 'main/projects'), join(dir, 'alt1/projects'));
      await expect(pool().transferSession(sid, 'default', 'alt1')).resolves.toBeUndefined();
      expect(await readFile(join(dir, 'alt1/projects/-r', `${sid}.jsonl`), 'utf8')).toBe('x\n');
    });

    it('knows whether an account can resume a session', async () => {
      await mkdir(join(dir, 'main/projects/-r'), { recursive: true });
      await writeFile(join(dir, 'main/projects/-r', `${sid}.jsonl`), 'x\n');
      const p = pool();
      expect(await p.hasSession(sid, 'default')).toBe(true);
      expect(await p.hasSession(sid, 'alt1')).toBe(false);
      expect(await p.hasSession('../x', 'default')).toBe(false);
      expect(p.has('alt1')).toBe(true);
      expect(p.has('nope')).toBe(false);
    });

    it('refuses a session id that could escape the folder', async () => {
      await mkdir(join(dir, 'main/projects'), { recursive: true });
      await expect(pool().transferSession('../../etc', 'default', 'alt1')).resolves.toBeUndefined();
    });
  });
});

describe('ClaudeAccountPool usage summary', () => {
  const accounts = parseClaudeAccounts('default,alt1', '/home/tester');
  const snap = (sevenDay: number, reset = 50_000): UsageLimitsSnapshot => ({
    fiveHour: { utilization: 0.1, resetsAt: null },
    sevenDay: { utilization: sevenDay, resetsAt: reset },
    scopedWeekly: [],
    fetchedAt: 7,
    stale: false,
  });

  it('is null with rotation off', () => {
    expect(new ClaudeAccountPool({ accounts: accounts.slice(0, 1) }).usageSummary()).toBeNull();
  });

  it('reports each account, the active one and benches', () => {
    let clock = 1_000;
    const pool = new ClaudeAccountPool({ accounts, now: () => clock });
    pool.noteUsage('default', snap(0.995));
    pool.noteUsage('alt1', snap(0.03));
    const s = pool.usageSummary()!;
    expect(s.active).toBe('alt1');
    expect(s.threshold).toBe(0.99);
    expect(s.accounts[0]).toMatchObject({ name: 'default', fetchedAt: 7, limitedUntil: 50_000, limitedReason: '7d 100%' });
    expect(s.accounts[1]).toMatchObject({ name: 'alt1', sevenDay: { utilization: 0.03 } });
    expect(s.accounts[1]!.limitedUntil).toBeUndefined();
    clock = 60_000;
    expect(pool.usageSummary()!.active).toBe('default');
  });

  it('notifies listeners on usage and benches', () => {
    const pool = new ClaudeAccountPool({ accounts, now: () => 1_000 });
    let calls = 0;
    const off = pool.subscribe(() => calls++);
    pool.noteUsage('alt1', snap(0.1));
    pool.markLimited('default', 'hit your limit', 9_999);
    expect(calls).toBe(2);
    off();
    pool.noteUsage('alt1', snap(0.2));
    expect(calls).toBe(2);
    pool.stop();
  });
});
