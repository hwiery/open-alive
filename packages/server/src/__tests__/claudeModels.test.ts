import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FALLBACK_TICKET_MODELS } from '@open-alive/core';
import { createClaudeModelCatalog, probeClaudeAlias } from '../claudeModels.js';
import { chmod, readdir } from 'node:fs/promises';

let dir: string;
let cacheFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-models-'));
  cacheFile = join(dir, 'claude-models.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const latest = { haiku: 'claude-haiku-6', sonnet: 'claude-sonnet-6', opus: 'claude-opus-6', fable: 'claude-fable-6-1' } as const;

describe('createClaudeModelCatalog', () => {
  it('starts from the fallback ids when nothing was probed yet', () => {
    const catalog = createClaudeModelCatalog({ cacheFile, findClaude: () => null });
    expect(catalog.current()).toEqual(FALLBACK_TICKET_MODELS);
    expect(catalog.get().probed).toEqual([]);
  });

  it('probes every tier, records the version and caches the result privately', async () => {
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => '/bin/claude',
      readVersion: async () => '9.9.9 (Claude Code)',
      readAuth: async () => true,
      probeAlias: async (_bin, tier) => latest[tier],
      now: () => 42,
    });
    const r = await catalog.refresh();
    expect(r.ok).toBe(true);
    expect(catalog.current()).toEqual(latest);
    expect(catalog.get()).toMatchObject({ version: '9.9.9 (Claude Code)', checkedAt: 42, probed: ['haiku', 'sonnet', 'opus', 'fable'] });

    const onDisk = JSON.parse(await readFile(cacheFile, 'utf-8'));
    expect(onDisk.models).toEqual(latest);
    if (process.platform !== 'win32') expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);

    // A restart reads the cache instead of showing the fallback ids.
    const reloaded = createClaudeModelCatalog({ cacheFile, findClaude: () => null });
    expect(reloaded.current()).toEqual(latest);
  });

  it('does not treat fallback ids in the cache as probed after a restart', async () => {
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => '/bin/claude',
      readVersion: async () => 'v',
      readAuth: async () => null,
      probeAlias: async (_bin, tier) => {
        if (tier === 'fable') throw new Error('not on this plan');
        return latest[tier];
      },
    });
    await catalog.refresh();
    const reloaded = createClaudeModelCatalog({ cacheFile, findClaude: () => null });
    expect(reloaded.get().probed).toEqual(['haiku', 'sonnet', 'opus']);
    expect(reloaded.current()).toEqual({ ...latest, fable: FALLBACK_TICKET_MODELS.fable });
  });

  it('reuses a fresh successful check instead of spawning the CLI again', async () => {
    let calls = 0;
    let clock = 1_000;
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => '/bin/claude',
      readVersion: async () => 'v',
      readAuth: async () => null,
      probeAlias: async (_bin, tier) => {
        calls += 1;
        return latest[tier];
      },
      now: () => clock,
      ttlMs: 60_000,
    });
    await catalog.refresh();
    clock += 30_000;
    await catalog.refresh();
    expect(calls).toBe(4);
    clock += 60_000;
    await catalog.refresh();
    expect(calls).toBe(8);
  });

  it('turns an unexpected throw into a failed result instead of a rejection', async () => {
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => {
        throw new Error('PATH unreadable');
      },
    });
    await expect(catalog.refresh()).resolves.toMatchObject({ ok: false, error: 'PATH unreadable' });
  });

  it('keeps the previous id for a tier whose probe fails', async () => {
    await writeFile(cacheFile, JSON.stringify({ models: latest, probed: ['haiku', 'sonnet', 'opus', 'fable'] }));
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => '/bin/claude',
      readVersion: async () => 'v',
      readAuth: async () => null,
      probeAlias: async (_bin, tier) => {
        if (tier === 'fable') throw new Error('fable not available on this plan');
        return tier === 'opus' ? 'claude-opus-7' : latest[tier];
      },
    });
    const r = await catalog.refresh();
    expect(r.ok).toBe(true);
    expect(catalog.current()).toEqual({ ...latest, opus: 'claude-opus-7' });
  });

  it('reports an error and keeps the cache when no tier answers', async () => {
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => '/bin/claude',
      readVersion: async () => 'v',
      readAuth: async () => null,
      probeAlias: async () => {
        throw new Error('Not logged in · Please run /login');
      },
    });
    const r = await catalog.refresh();
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain('Please run /login');
    expect(catalog.current()).toEqual(FALLBACK_TICKET_MODELS);
  });

  it('fails the check when the CLI is installed but not logged in, without probing models', async () => {
    let probed = false;
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => '/bin/claude',
      readVersion: async () => 'v',
      readAuth: async () => false,
      probeAlias: async () => {
        probed = true;
        return 'claude-opus-9';
      },
    });
    const r = await catalog.refresh();
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain('not logged in');
    expect(probed).toBe(false);
  });

  it('reports a missing CLI without probing', async () => {
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => null,
      probeAlias: async () => {
        throw new Error('should not run');
      },
    });
    expect(await catalog.refresh()).toMatchObject({ ok: false, error: 'claude not found on PATH' });
  });

  it('shares one probe between concurrent refreshes', async () => {
    let calls = 0;
    const catalog = createClaudeModelCatalog({
      cacheFile,
      findClaude: () => '/bin/claude',
      readVersion: async () => 'v',
      readAuth: async () => null,
      probeAlias: async (_bin, tier) => {
        calls += 1;
        return latest[tier];
      },
    });
    await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(calls).toBe(4);
  });

  it('ignores a cache file that does not hold Claude model ids', async () => {
    await writeFile(cacheFile, JSON.stringify({ models: { opus: '$(evil)' } }));
    const catalog = createClaudeModelCatalog({ cacheFile, findClaude: () => null });
    expect(catalog.current()).toEqual(FALLBACK_TICKET_MODELS);
  });
});

// The fake CLI is a sh script, so these run on POSIX hosts only.
describe.skipIf(process.platform === 'win32')('probeClaudeAlias', () => {
  it('reads the init event from a private cwd with user-only settings, then cleans up', async () => {
    const log = join(dir, 'log');
    const bin = join(dir, 'fake-claude');
    await writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$PWD" "$(ls -ld . | cut -c1-10)" "$*" > "${log}"\n` +
        `echo '{"type":"system","subtype":"init","model":"claude-opus-9-1"}'\nsleep 5\n`,
    );
    await chmod(bin, 0o755);
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('oa-claude-probe-')).length;

    await expect(probeClaudeAlias(bin, 'opus', 5000)).resolves.toBe('claude-opus-9-1');

    const [cwd, mode, args] = (await readFile(log, 'utf-8')).trim().split('\n');
    expect(cwd).toContain('oa-claude-probe-');
    expect(mode).toBe('drwx------');
    expect(args).toContain('--setting-sources user');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('disableAllHooks');
    expect(args).toContain('--no-session-persistence');
    expect((await readdir(tmpdir())).filter((n) => n.startsWith('oa-claude-probe-')).length).toBe(before);
  });

  it('keeps an init line written just before the CLI exits', async () => {
    const bin = join(dir, 'fake-claude');
    await writeFile(bin, `#!/bin/sh\necho '{"type":"system","subtype":"init","model":"claude-sonnet-9"}'\necho 'Not logged in' >&2\nexit 1\n`);
    await chmod(bin, 0o755);
    await expect(probeClaudeAlias(bin, 'sonnet', 5000)).resolves.toBe('claude-sonnet-9');
  });

  it('rejects an init event without a Claude model id', async () => {
    const bin = join(dir, 'fake-claude');
    await writeFile(bin, `#!/bin/sh\necho '{"type":"system","subtype":"init","model":"; rm -rf /"}'\n`);
    await chmod(bin, 0o755);
    await expect(probeClaudeAlias(bin, 'opus', 5000)).rejects.toThrow(/unexpected model id/);
  });
});
