import * as pty from 'node-pty';
import { homedir } from 'node:os';
import type { SSHErrorKind, TerminalMode } from '@open-alive/core';
import { resolveCli } from './spawnCli.js';
import { augmentPath } from './envPath.js';
import { resolveLocalModel, type LocalModel } from './localModel.js';

/** Environment variables that must be removed to avoid nested-session errors */
const CLAUDE_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT'];

/** Strip ANSI escape sequences so regex matching is reliable. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Ordered list — first match wins. */
const SSH_ERROR_PATTERNS: { kind: SSHErrorKind; pattern: RegExp }[] = [
  { kind: 'host-key-changed', pattern: /REMOTE HOST IDENTIFICATION HAS CHANGED/i },
  { kind: 'host-key', pattern: /Host key verification failed/i },
  { kind: 'permission-denied', pattern: /Permission denied \(publickey|Permission denied, please try again|Permission denied \(.*password/i },
  { kind: 'connection-refused', pattern: /Connection refused/i },
  { kind: 'dns', pattern: /(Could not resolve hostname|Name or service not known|Temporary failure in name resolution)/i },
  { kind: 'timeout', pattern: /(Connection timed out|Operation timed out)/i },
  { kind: 'unknown', pattern: /(kex_exchange_identification|ssh: connect to host .* port .*:)/i },
];

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_KEYS.includes(k)) {
      env[k] = v;
    }
  }
  env.PATH = augmentPath(env.PATH);
  return env;
}

function userShell(): string {
  return process.env.SHELL || '/bin/zsh';
}

/**
 * What node-pty starts for a terminal tab. POSIX: the user's login shell.
 * Windows: PowerShell (always present; ConPTY gives it a real console).
 */
export function terminalLaunch(
  mode: TerminalMode,
  command: string,
  platform: NodeJS.Platform = process.platform,
  shell: string = userShell(),
): { file: string; args: string[] } {
  if (platform === 'win32') {
    return mode !== 'shell'
      ? { file: 'powershell.exe', args: ['-NoLogo', '-Command', command] }
      : { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return mode !== 'shell' ? { file: shell, args: ['-l', '-c', command] } : { file: shell, args: ['-l', '-i'] };
}

export interface SpawnOptions {
  handler: (data: string) => void;
  cols?: number;
  rows?: number;
  onExit?: (exitCode: number) => void;
  onSshError?: (err: { kind: SSHErrorKind; line: string }) => void;
  cwd?: string;
  mode?: TerminalMode;
  /** Claude CLI entrypoint: `claude` (default) or `claude agents`. */
  claudeVariant?: 'claude' | 'agents';
  skipPermissions?: boolean;
  initialCommand?: string;
  detectSshErrors?: boolean;
  /** UUID for `claude --session-id` (ignored if resumeSessionId is set). */
  claudeSessionId?: string;
  /** Existing Claude session UUID for `claude --resume <id>`. */
  resumeSessionId?: string;
  /** Display name for `claude -n <name>`. */
  displayName?: string;
  /** Codex only: run on the local model from `OA_LOCAL_MODEL` (`codex --oss`). */
  localModel?: boolean;
  /** Claude only: extra env for the `claude` process (e.g. CLAUDE_CONFIG_DIR for account rotation). */
  extraEnv?: Record<string, string>;
}

/**
 * Escape a string for safe use inside a single-quoted shell argument.
 * Used only for the `-n` display name. Accepts any user input.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Claude CLI session UUIDs must be v4 format. Validate defensively. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PowerShell single-quoted literal: only `'` needs escaping, by doubling it. */
function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface ClaudeCommandOptions {
  /** Shell that will run the string: POSIX `sh -c` (default) or Windows PowerShell. */
  shell?: 'posix' | 'powershell';
  /**
   * PowerShell only: absolute path of the CLI. Invoked with `&` so PowerShell
   * runs `claude.cmd`/`claude.exe` and never the npm `.ps1` shim, which the
   * default execution policy blocks.
   */
  claudePath?: string;
  claudeVariant?: 'claude' | 'agents';
  skipPermissions?: boolean;
  claudeSessionId?: string;
  resumeSessionId?: string;
  displayName?: string;
  /**
   * Claude Code `tui` setting for this session only, passed as `--settings`.
   * Null keeps whatever the user's own settings say.
   */
  tui?: string | null;
}

/**
 * `tui` for dashboard terminals, from `OPEN_ALIVE_CLAUDE_TUI`. Defaults to
 * `default`: with `tui: "fullscreen"` Claude draws on the alternate screen, so
 * xterm keeps no scrollback and the tab has no scrollbar. `inherit` (or a value
 * that isn't a plain word) leaves the user's own setting alone.
 */
export function resolveClaudeTui(env: NodeJS.ProcessEnv): string | null {
  const value = env.OPEN_ALIVE_CLAUDE_TUI?.trim() || 'default';
  if (value === 'inherit' || !/^[a-z-]+$/.test(value)) return null;
  return value;
}

/**
 * Build the shell command string for the chosen Claude entrypoint.
 *
 * `claude` (root) and `claude agents` (background-agent manager) do NOT share
 * the same flag set — verified against Claude Code CLI 2.1.x:
 *   - `claude`        : --session-id, --resume, -n, --dangerously-skip-permissions
 *   - `claude agents` : --dangerously-skip-permissions only (of the ones we emit)
 * Passing --session-id/--resume/-n to `claude agents` fails with
 * `error: unknown option '--session-id'`, so those are omitted for that variant.
 */
export function buildClaudeCommand(opts: ClaudeCommandOptions): string {
  const { claudeVariant = 'claude', skipPermissions, claudeSessionId, resumeSessionId, displayName, tui } = opts;
  const ps = opts.shell === 'powershell';
  const quote = ps ? powershellQuote : shellSingleQuote;
  const claude = ps ? `& ${powershellQuote(opts.claudePath ?? 'claude')}` : 'claude';

  if (claudeVariant === 'agents') {
    const args: string[] = [];
    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    return args.length > 0 ? `${claude} agents ${args.join(' ')}` : `${claude} agents`;
  }

  const args: string[] = [];
  // --resume takes precedence over --session-id (resuming a past conversation).
  if (resumeSessionId && UUID_V4.test(resumeSessionId)) {
    args.push('--resume', resumeSessionId);
  } else if (claudeSessionId && UUID_V4.test(claudeSessionId)) {
    args.push('--session-id', claudeSessionId);
  }
  if (displayName && displayName.trim().length > 0) {
    args.push('-n', quote(displayName.trim()));
  }
  if (skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (tui) {
    args.push('--settings', quote(JSON.stringify({ tui })));
  }
  return args.length > 0 ? `${claude} ${args.join(' ')}` : claude;
}

export interface CodexCommandOptions {
  shell?: 'posix' | 'powershell';
  /** PowerShell only: absolute path of the CLI (see ClaudeCommandOptions.claudePath). */
  codexPath?: string;
  skipPermissions?: boolean;
  /** Run on a local model through Codex's open-source provider. */
  local?: LocalModel;
}

/** Shell command for an interactive Codex CLI session. */
export function buildCodexCommand(opts: CodexCommandOptions): string {
  const ps = opts.shell === 'powershell';
  const args = [ps ? `& ${powershellQuote(opts.codexPath ?? 'codex')}` : 'codex'];
  if (opts.local) {
    args.push('--oss', '--local-provider', opts.local.provider, '-m', (ps ? powershellQuote : shellSingleQuote)(opts.local.model));
  }
  if (opts.skipPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
  return args.join(' ');
}

export class ClaudeTerminal {
  private ptyProc: pty.IPty | null = null;
  private onData: ((data: string) => void) | null = null;
  private onSshError: ((err: { kind: SSHErrorKind; line: string }) => void) | null = null;
  private detectErrors = false;
  private lineBuffer = '';
  private reportedErrors = new Set<SSHErrorKind>();

  spawn(opts: SpawnOptions): void {
    if (this.ptyProc) {
      this.ptyProc.kill();
      this.ptyProc = null;
    }

    const {
      handler,
      cols = 80,
      rows = 24,
      onExit,
      onSshError,
      cwd,
      mode = 'claude',
      claudeVariant = 'claude',
      skipPermissions,
      initialCommand,
      detectSshErrors = false,
      claudeSessionId,
      resumeSessionId,
      displayName,
      localModel,
      extraEnv,
    } = opts;

    this.onData = handler;
    this.onSshError = onSshError ?? null;
    this.detectErrors = detectSshErrors;
    this.lineBuffer = '';
    this.reportedErrors.clear();

    const shell = userShell();
    const env = cleanEnv();
    const cwdResolved = cwd || homedir();

    if (mode === 'claude') {
      if (extraEnv) Object.assign(env, extraEnv);
      const win = process.platform === 'win32';
      const claudeCmd = buildClaudeCommand({
        ...(win ? { shell: 'powershell' as const, claudePath: resolveCli('claude', env) ?? 'claude' } : {}),
        claudeVariant,
        skipPermissions,
        claudeSessionId,
        resumeSessionId,
        displayName,
        tui: resolveClaudeTui(process.env),
      });
      const launch = terminalLaunch('claude', claudeCmd, process.platform, shell);
      this.ptyProc = pty.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwdResolved,
        env,
      });
    } else if (mode === 'codex') {
      const win = process.platform === 'win32';
      const local = localModel ? resolveLocalModel(process.env) : undefined;
      // Never fall back to the cloud model when a local run was asked for.
      if (local === null) throw new Error('OA_LOCAL_MODEL is not set or invalid');
      const codexCmd = buildCodexCommand({
        local,
        ...(win ? { shell: 'powershell' as const, codexPath: resolveCli('codex', env) ?? 'codex' } : {}),
        skipPermissions,
      });
      const launch = terminalLaunch('codex', codexCmd, process.platform, shell);
      this.ptyProc = pty.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwdResolved,
        env,
      });
    } else {
      // Interactive shell mode (used for SSH presets and freeform terminals).
      const launch = terminalLaunch('shell', '', process.platform, shell);
      this.ptyProc = pty.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwdResolved,
        env,
      });
    }

    this.ptyProc.onData((data) => {
      this.onData?.(data);
      if (this.detectErrors) {
        this.scanForSshErrors(data);
      }
    });

    this.ptyProc.onExit(({ exitCode }) => {
      this.ptyProc = null;
      onExit?.(exitCode);
    });

    if (initialCommand && initialCommand.trim().length > 0) {
      // Delay to let the shell print its prompt first so the command lands on a clean line.
      setTimeout(() => {
        this.ptyProc?.write(`${initialCommand}\r`);
      }, 120);
    }
  }

  /** Assemble lines from PTY output and match SSH error patterns. */
  private scanForSshErrors(chunk: string): void {
    this.lineBuffer += chunk;
    // Keep last ~16KB in buffer to avoid unbounded growth.
    if (this.lineBuffer.length > 16_384) {
      this.lineBuffer = this.lineBuffer.slice(-8_192);
    }

    const parts = this.lineBuffer.split(/\r?\n/);
    // Last element may be an incomplete line — keep it for next chunk.
    this.lineBuffer = parts.pop() ?? '';

    for (const rawLine of parts) {
      const line = rawLine.replace(ANSI_PATTERN, '').trim();
      if (line.length === 0) continue;
      for (const { kind, pattern } of SSH_ERROR_PATTERNS) {
        if (this.reportedErrors.has(kind)) continue;
        if (pattern.test(line)) {
          this.reportedErrors.add(kind);
          this.onSshError?.({ kind, line });
          break;
        }
      }
    }
  }

  write(data: string): void {
    this.ptyProc?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.ptyProc) return;
    try {
      this.ptyProc.resize(cols, rows);
    } catch {
      // The pty already exited (node-pty throws `ioctl(2) failed, EBADF`). A
      // resize from the browser can race that exit; it must never take the
      // server down with it.
    }
  }

  get isAlive(): boolean {
    return this.ptyProc !== null;
  }

  destroy(): void {
    if (this.ptyProc) {
      this.ptyProc.kill();
      this.ptyProc = null;
    }
    this.onData = null;
    this.onSshError = null;
    this.lineBuffer = '';
    this.reportedErrors.clear();
  }
}
