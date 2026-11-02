/**
 * Headless Codex runs (`codex exec --json`) reduced to the same outcome shape as
 * a headless Claude run, so the ticket runner, verifier and run history treat
 * both engines alike.
 *
 * Codex JSONL, verified against codex-cli 0.148:
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens",…}}
 *   {"type":"turn.failed","error":{"message":"…"}} / {"type":"error","message":"…"}
 * The thread id is the resume handle (`codex exec resume <id>`).
 */
import { delimiter } from 'node:path';
import { resolveCli, spawnCli } from './spawnCli.js';
import { consumeHeadless, cleanEnv, type HeadlessProcessHandle, type HeadlessRunHandle } from './headlessClaude.js';
import type { StreamEvent, StreamResult, StreamUsage } from './streamJson.js';

export interface CodexRunOptions {
  goal: string;
  cwd: string;
  /** `bypassPermissions` → no sandbox/approvals (same trust as the Claude runs); anything else → workspace-write. */
  permissionMode: string;
  model?: string;
  effort?: string;
  /** Codex thread id to continue. */
  resumeSessionId?: string;
  pathPrepend?: string;
  extraEnv?: Record<string, string>;
  onEvent?: (e: StreamEvent) => void;
  /** Injectable for tests. */
  spawnProcess?: (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => HeadlessProcessHandle;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function codexUsage(raw: unknown): StreamUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const input = num(u.input_tokens);
  const cached = num(u.cached_input_tokens);
  const output = num(u.output_tokens);
  const reasoning = num(u.reasoning_output_tokens);
  const usage: StreamUsage = {
    // Codex counts cached tokens inside input_tokens; split them like Claude does.
    ...(input !== undefined ? { inputTokens: Math.max(0, input - (cached ?? 0)) } : {}),
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(output !== undefined ? { outputTokens: output + (reasoning ?? 0) } : {}),
  };
  const parts = [usage.inputTokens, usage.cacheReadTokens, usage.outputTokens].filter((n): n is number => n !== undefined);
  if (parts.length === 0) return null;
  return { ...usage, totalTokens: parts.reduce((a, b) => a + b, 0), numTurns: 1 };
}

/** Line parser with the `push`/`flush` shape of `createStreamJsonParser`. */
export function createCodexJsonParser(onEvent: (e: StreamEvent) => void, opts: { model?: string } = {}) {
  let buffer = '';
  let threadId: string | null = null;
  let lastMessage: string | null = null;
  let lastError: string | null = null;
  let finished = false;

  const result = (r: Omit<StreamResult, 'sessionId' | 'model'>): void => {
    finished = true;
    onEvent({ kind: 'result', result: { ...r, sessionId: threadId, model: opts.model ?? null } });
  };

  const line = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      obj = parsed as Record<string, unknown>;
    } catch {
      return; // one bad line must not kill the run
    }
    switch (obj.type) {
      case 'thread.started':
        threadId = typeof obj.thread_id === 'string' ? obj.thread_id : null;
        onEvent({ kind: 'init', sessionId: threadId });
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = obj.item as { type?: unknown; text?: unknown; message?: unknown } | undefined;
        if (obj.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
          lastMessage = item.text;
        }
        onEvent({ kind: 'activity' });
        return;
      }
      case 'turn.started':
        onEvent({ kind: 'activity' });
        return;
      case 'turn.completed':
        result({ result: lastMessage, isError: false, subtype: 'success', usage: codexUsage(obj.usage) });
        return;
      case 'turn.failed': {
        const message = (obj.error as { message?: unknown } | undefined)?.message;
        result({ result: typeof message === 'string' ? message : lastError, isError: true, subtype: 'error_during_execution', usage: null });
        return;
      }
      case 'error':
        if (typeof obj.message === 'string') lastError = obj.message;
        return;
      default:
        return;
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    flush(): void {
      if (buffer.trim()) line(buffer);
      buffer = '';
      // A stream that ended on a bare `error` still deserves an error result.
      if (!finished && lastError) result({ result: lastError, isError: true, subtype: 'error_during_execution', usage: null });
    },
  };
}

/**
 * argv for `codex exec` (or `codex exec resume`). `resume` takes no `-C`/`-s`,
 * so the working directory comes from the process cwd and the sandbox from
 * `-c sandbox_mode`. Positionals follow `--`, so a prompt starting with `-` is
 * never read as a flag.
 */
export function buildCodexArgs(o: Pick<CodexRunOptions, 'goal' | 'cwd' | 'permissionMode' | 'model' | 'effort' | 'resumeSessionId'>): string[] {
  const bypass = o.permissionMode === 'bypassPermissions';
  const args = o.resumeSessionId ? ['exec', 'resume'] : ['exec', '-C', o.cwd];
  args.push('--json', '--skip-git-repo-check');
  if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
  else if (o.resumeSessionId) args.push('-c', 'sandbox_mode="workspace-write"');
  else args.push('-s', 'workspace-write');
  if (o.model) args.push('-m', o.model);
  if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
  args.push('--');
  if (o.resumeSessionId) args.push(o.resumeSessionId);
  args.push(o.goal);
  return args;
}

function realSpawn(argv: string[], cwd: string, env: NodeJS.ProcessEnv): HeadlessProcessHandle {
  const child = spawnCli(resolveCli('codex', env), argv, { cwd, env }, 'codex');
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    onExit: (cb) => {
      child.on('error', () => cb(null, null));
      child.on('exit', (code, signal) => cb(code, signal));
    },
  };
}

export function runHeadlessCodex(options: CodexRunOptions): HeadlessRunHandle {
  const env = cleanEnv();
  if (options.pathPrepend) env.PATH = `${options.pathPrepend}${delimiter}${env.PATH ?? ''}`;
  if (options.extraEnv) Object.assign(env, options.extraEnv);
  const argv = buildCodexArgs(options);
  const proc = (options.spawnProcess ?? realSpawn)(argv, options.cwd, env);
  return consumeHeadless(proc, options.onEvent, (onEvent) => createCodexJsonParser(onEvent, { model: options.model }));
}
