/**
 * `open-alive account add|list` — set up extra Claude accounts for ticket
 * rotation (server side: packages/server/src/claudeAccounts.ts).
 *
 * An account is a Claude Code config directory, `~/.claude-<name>`. Its login
 * is its own; everything else is shared with the main directory through
 * symlinks, so a ticket behaves the same on every account:
 *   - `projects/` shares session transcripts, which is what lets `--resume`
 *     continue a session started under another account;
 *   - settings.json (and with it the open-alive hooks), CLAUDE.md, skills,
 *     agents, commands, plugins and output styles.
 * Only entries that exist in the main directory and are absent from the new
 * one are linked; nothing already there is replaced.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEnvKey, upsertEnvValue } from '@open-alive/core';

export const ACCOUNTS_ENV_KEY = 'OA_CLAUDE_ACCOUNTS';
export const SHARED_ENTRIES = [
  'projects',
  'settings.json',
  'CLAUDE.md',
  'skills',
  'agents',
  'commands',
  'plugins',
  'output-styles',
] as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export function validateAccountName(name: string | undefined): string | null {
  if (!name) return 'Usage: open-alive account add <name>';
  if (name === 'default') return '"default" is the login Claude Code already uses; pick another name.';
  if (!NAME_RE.test(name)) return 'Use letters, digits, _ . - (max 40 characters).';
  return null;
}

export function mainClaudeDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
}

export function accountDir(name: string, home: string = homedir()): string {
  return join(home, `.claude-${name}`);
}

/** Link shared entries from `mainDir` into `dir`. Returns the names linked. */
export function linkSharedEntries(mainDir: string, dir: string): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const linked: string[] = [];
  for (const entry of SHARED_ENTRIES) {
    const src = join(mainDir, entry);
    const dst = join(dir, entry);
    if (!existsSync(src)) continue;
    let present = false;
    try {
      lstatSync(dst);
      present = true;
    } catch {
      // absent
    }
    if (present) continue;
    symlinkSync(src, dst);
    linked.push(entry);
  }
  return linked;
}

/**
 * Copy user-scope MCP servers into the new account's `.claude.json` (that file
 * also holds the login, so it cannot be shared). Only when the new file has
 * none of its own. Returns how many were copied.
 */
export function copyMcpServers(mainJsonPath: string, accountJsonPath: string): number {
  let main: Record<string, unknown>;
  let account: Record<string, unknown>;
  try {
    main = JSON.parse(readFileSync(mainJsonPath, 'utf8')) as Record<string, unknown>;
    account = JSON.parse(readFileSync(accountJsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return 0;
  }
  const servers = main.mcpServers;
  if (!servers || typeof servers !== 'object' || account.mcpServers) return 0;
  const count = Object.keys(servers).length;
  if (count === 0) return 0;
  writeFileSync(accountJsonPath, JSON.stringify({ ...account, mcpServers: servers }, null, 2), { mode: 0o600 });
  return count;
}

/** The `.claude.json` Claude Code uses for a config dir (in $HOME for the default dir). */
export function claudeJsonFor(dir: string | null, home: string = homedir()): string {
  return dir ? join(dir, '.claude.json') : join(home, '.claude.json');
}

/** Add `name` to OA_CLAUDE_ACCOUNTS (starting the list with `default`). */
export function addAccountToEnv(text: string, name: string): string {
  const current = readEnvKey(text, ACCOUNTS_ENV_KEY);
  const names = (current ?? 'default').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.some((n) => n === name || n.startsWith(`${name}=`))) return text;
  return upsertEnvValue(text, ACCOUNTS_ENV_KEY, [...names, name].join(','));
}

export function listAccounts(text: string): string[] {
  const current = readEnvKey(text, ACCOUNTS_ENV_KEY) ?? process.env[ACCOUNTS_ENV_KEY];
  return (current ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
