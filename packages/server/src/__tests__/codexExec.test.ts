import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs, createCodexJsonParser, runHeadlessCodex } from '../codexExec.js';
import { createCodexExecutor } from '../executors/codexExecutor.js';
import { createCodexModelCatalog, parseCodexModels } from '../codexModels.js';
import type { StreamEvent } from '../streamJson.js';
import type { HeadlessProcessHandle } from '../headlessClaude.js';

const SAMPLE = [
  '{"type":"thread.started","thread_id":"t-123"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done\\nHEADLINE: ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50,"reasoning_output_tokens":10}}',
].join('\n');

function parse(text: string, model?: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  const p = createCodexJsonParser((e) => events.push(e), { model });
  p.push(text);
  p.flush();
  return events;
}

describe('createCodexJsonParser', () => {
  it('maps a codex run to init, activity and a result with usage', () => {
    const events = parse(SAMPLE + '\n', 'gpt-5.6-terra');
    expect(events[0]).toEqual({ kind: 'init', sessionId: 't-123' });
    const result = events.find((e) => e.kind === 'result');
    expect(result).toEqual({
      kind: 'result',
      result: {
        result: 'done\nHEADLINE: ok',
        isError: false,
        sessionId: 't-123',
        subtype: 'success',
        model: 'gpt-5.6-terra',
        usage: { inputTokens: 600, cacheReadTokens: 400, outputTokens: 60, totalTokens: 1060, numTurns: 1 },
      },
    });
  });

  it('reports a failed turn as an error result', () => {
    const events = parse('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.failed","error":{"message":"model requires a newer Codex"}}\n');
    expect(events.at(-1)).toMatchObject({ kind: 'result', result: { isError: true, result: 'model requires a newer Codex' } });
  });

  it('turns a stream that ends on a bare error into an error result, and skips bad lines', () => {
    const events = parse('not json\n{"type":"error","message":"Not logged in"}');
    expect(events).toEqual([
      { kind: 'result', result: { result: 'Not logged in', isError: true, subtype: 'error_during_execution', usage: null, sessionId: null, model: null } },
    ]);
  });
});

describe('buildCodexArgs', () => {
  it('runs in the ticket cwd with the chosen model and effort; the prompt follows --', () => {
    expect(buildCodexArgs({ goal: '-rf work', cwd: '/r', permissionMode: 'bypassPermissions', model: 'gpt-5.6-terra', effort: 'high' })).toEqual([
      'exec', '-C', '/r', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="high"', '--', '-rf work',
    ]);
  });

  it('resumes a thread without the flags resume does not accept', () => {
    const args = buildCodexArgs({ goal: 'go on', cwd: '/r', permissionMode: 'default', resumeSessionId: 't-1' });
    expect(args).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '--', 't-1', 'go on']);
    expect(args).not.toContain('-C');
  });
});

function fakeProcess(stdoutText: string, code = 0): HeadlessProcessHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit: ((c: number | null, s?: string | null) => void) | undefined;
  setTimeout(() => {
    stdout.end(stdoutText);
    stderr.end();
    setTimeout(() => exit?.(code, null), 5);
  }, 5);
  return { stdout, stderr, kill: () => {}, onExit: (cb) => { exit = cb; } };
}

describe('runHeadlessCodex', () => {
  it('produces the same outcome shape as a Claude run', async () => {
    let seenArgv: string[] = [];
    const handle = runHeadlessCodex({
      goal: 'g',
      cwd: '/r',
      permissionMode: 'bypassPermissions',
      model: 'gpt-5.6-terra',
      spawnProcess: (argv) => {
        seenArgv = argv;
        return fakeProcess(SAMPLE + '\n');
      },
    });
    const outcome = await handle.done;
    expect(seenArgv).toContain('gpt-5.6-terra');
    expect(outcome).toMatchObject({ exitCode: 0, sessionId: 't-123', result: { result: 'done\nHEADLINE: ok', model: 'gpt-5.6-terra' } });
  });
});

describe('createCodexExecutor', () => {
  const base = { validateCwd: async (cwd: string) => (cwd === '/ok' ? null : 'bad cwd'), spawn: () => { throw new Error('unused'); } };
  const catalog = (id: string) => (id === 'gpt-5.5' ? { id, label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], listed: false } : undefined);

  it('uses the base cwd rules and drops an effort the model does not list', async () => {
    const calls: unknown[] = [];
    const resolved: unknown[] = [];
    const executor = createCodexExecutor({
      base,
      findModel: catalog,
      run: (o) => {
        calls.push(o);
        return { kill: () => {}, done: Promise.resolve({ exitCode: 0, result: null, sessionId: null, stderr: '' }) };
      },
    });
    expect(await executor.validateCwd('/nope')).toBe('bad cwd');
    executor.spawn({ goal: 'g', cwd: '/ok', permissionMode: 'bypassPermissions', run: { model: 'gpt-5.5', effort: 'max' }, onFlagsResolved: (r) => resolved.push(r) });
    expect(calls[0]).toMatchObject({ model: 'gpt-5.5' });
    expect(calls[0]).not.toHaveProperty('effort');
    expect(resolved[0]).toEqual({ model: 'gpt-5.5', dropped: ['--effort'] });
  });
});

describe('codex model catalogue', () => {
  const debugModels = JSON.stringify({
    models: [
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: '--evil', display_name: 'x' },
    ],
  });

  it('parses only valid ids, with efforts and visibility', () => {
    expect(parseCodexModels(JSON.parse(debugModels))).toEqual([
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: ['low', 'max'], listed: true },
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low'], listed: false },
    ]);
  });

  it('requires a login, caches the list and answers `has`', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-cat-'));
    const cacheFile = join(dir, 'codex-models.json');
    try {
      let loggedIn = false;
      const catalog = createCodexModelCatalog({
        cacheFile,
        findCodex: () => '/bin/codex',
        run: async (_bin, args) => {
          if (args[0] === '--version') return 'codex-cli 0.148.0\n';
          if (args[0] === 'login') {
            if (!loggedIn) throw new Error('Not logged in');
            return 'Logged in using ChatGPT';
          }
          return debugModels;
        },
      });
      expect(await catalog.refresh()).toMatchObject({ ok: false, error: 'not logged in: Not logged in' });
      loggedIn = true;
      expect(await catalog.refresh()).toMatchObject({ ok: true });
      expect(catalog.has('gpt-5.5')).toBe(true);
      expect(catalog.has('gpt-9')).toBe(false);
      expect(JSON.parse(await readFile(cacheFile, 'utf-8')).version).toBe('codex-cli 0.148.0');
      const reloaded = createCodexModelCatalog({ cacheFile, findCodex: () => null });
      expect(reloaded.has('gpt-5.6-terra')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-cat-'));
    try {
      await writeFile(join(dir, 'x'), '');
      const catalog = createCodexModelCatalog({ cacheFile: join(dir, 'c.json'), findCodex: () => null });
      expect(await catalog.refresh()).toMatchObject({ ok: false, error: 'codex not found on PATH' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
