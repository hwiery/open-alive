/**
 * Start the agent CLIs (`claude`, `codex`) the same way on every platform.
 *
 * On Windows npm installs them as `.cmd` shims, which `child_process.spawn`
 * refuses to run without a shell — and running them through a shell would let a
 * prompt's quotes and `&`/`|` reach cmd.exe. `cross-spawn` resolves the shim and
 * escapes every argument for cmd.exe, so a ticket goal is always one argument.
 * Elsewhere it is a plain `spawn`.
 */
import crossSpawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { augmentPath, findExecutable } from '@open-alive/core';

/**
 * Absolute path of a CLI on the augmented PATH, or null. Never the bare name:
 * on Windows a bare name is looked up in the current directory first — and
 * agent CLIs run with a ticket's repository as their cwd, so a `claude.cmd`
 * committed there would run instead. Nor any placeholder path, which someone
 * else could create (a shared temp dir).
 */
export function resolveCli(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return findExecutable(name, augmentPath(env.PATH));
}

/**
 * Stand-in for a CLI that is not installed: nothing is executed; it reports
 * ENOENT (then exit/close) the way `spawn` does for a missing binary.
 */
function missingCli(name: string): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & EventEmitter;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr, stdin: null, pid: undefined, kill: () => true });
  process.nextTick(() => {
    const error = Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${name}`, path: name });
    child.emit('error', error);
    stdout.end();
    stderr.end();
    child.emit('exit', null, null);
    child.emit('close', null, null);
  });
  return child;
}

/** Find a CLI on the augmented PATH; null when it is not installed. */
export function findCli(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return findExecutable(name, augmentPath(env.PATH));
}

/** `command` is an absolute path from {@link resolveCli}; null means not installed. */
export function spawnCli(
  command: string | null,
  args: readonly string[],
  options: SpawnOptions,
  name = 'cli',
): ChildProcessWithoutNullStreams {
  if (command === null) return missingCli(name);
  return crossSpawn(command, [...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a CLI to completion and collect its output (the cross-platform `execFile`). */
export function runCli(
  command: string | null,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number } = {},
): Promise<CliResult> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args, { env: options.env ?? process.env }, command ?? 'cli');
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (done) return;
          done = true;
          child.kill();
          reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < maxBytes) stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < maxBytes) stderr += c.toString();
    });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
