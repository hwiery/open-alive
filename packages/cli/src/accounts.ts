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
 * Top-level `.claude.json` keys copied to a new account: onboarding done, which
 * notices and dialogs were already seen or accepted, and install preferences.
 * Without them an interactive `claude` on the account opens with the first-run
 * wizard (theme picker, trust prompts) as if Claude Code were new. Identity
 * (`oauthAccount`, `userID`), caches and usage counters are never copied.
 */
const STATE_KEYS = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'lastReleaseNotesSeen',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'optionAsMetaKeyInstalled',
  'codeModeCaveatsAcceptedV1',
  'codeModeAutoModeCaveatAcceptedV1',
  'hasSeenAutoModeEntryWarning',
  'hasSeenAutoDefaultNotice',
  'hasSeenTasksHint',
  'hasUsedBackslashReturn',
  'hasOpenedAgentsView',
  'remoteDialogSeen',
] as const;

/** Per-folder settings copied (trust and tool approvals); per-folder run metrics are not. */
const PROJECT_KEYS = [
  'hasTrustDialogAccepted',
  'allowedTools',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
] as const;

export interface CopiedState {
  mcpServers: number;
  keys: number;
  projects: number;
}

/**
 * Copy what makes Claude Code feel set up from the main `.claude.json` into an
 * account's (that file also holds the login, so it cannot be shared): user MCP
 * servers, onboarding/notice flags, and per-folder trust. Only fills what the
 * account does not have yet; nothing of its own is overwritten.
 */
export function copyClaudeState(mainJsonPath: string, accountJsonPath: string): CopiedState {
  const none: CopiedState = { mcpServers: 0, keys: 0, projects: 0 };
  let main: Record<string, unknown>;
  let account: Record<string, unknown>;
  try {
    main = JSON.parse(readFileSync(mainJsonPath, 'utf8')) as Record<string, unknown>;
    account = JSON.parse(readFileSync(accountJsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return none;
  }
  const out: CopiedState = { ...none };
  const next: Record<string, unknown> = { ...account };

  const servers = main.mcpServers;
  const own = account.mcpServers;
  if (servers && typeof servers === 'object' && (!own || (typeof own === 'object' && Object.keys(own).length === 0))) {
    out.mcpServers = Object.keys(servers).length;
    if (out.mcpServers > 0) next.mcpServers = servers;
  }
  for (const key of STATE_KEYS) {
    if (key in main && !(key in account)) {
      next[key] = main[key];
      out.keys++;
    }
  }
  const mainProjects = main.projects;
  if (mainProjects && typeof mainProjects === 'object') {
    const projects: Record<string, Record<string, unknown>> = {
      ...((account.projects as Record<string, Record<string, unknown>> | undefined) ?? {}),
    };
    for (const [path, entry] of Object.entries(mainProjects as Record<string, Record<string, unknown>>)) {
      if (!entry || typeof entry !== 'object') continue;
      const target = { ...(projects[path] ?? {}) };
      let added = false;
      for (const key of PROJECT_KEYS) {
        if (key in entry && !(key in target)) {
          target[key] = entry[key];
          added = true;
        }
      }
      if (added) {
        projects[path] = target;
        out.projects++;
      }
    }
    if (out.projects > 0) next.projects = projects;
  }
  if (out.mcpServers + out.keys + out.projects > 0) {
    writeFileSync(accountJsonPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  }
  return out;
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
