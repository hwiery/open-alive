import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAccountToEnv, copyMcpServers, linkSharedEntries, validateAccountName, listAccounts } from '../accounts.js';

describe('validateAccountName', () => {
  it('rejects missing, default and odd names', () => {
    expect(validateAccountName(undefined)).not.toBeNull();
    expect(validateAccountName('default')).not.toBeNull();
    expect(validateAccountName('../x')).not.toBeNull();
    expect(validateAccountName('alt1')).toBeNull();
  });
});

describe('addAccountToEnv', () => {
  it('starts the list with default', () => {
    expect(addAccountToEnv('PORT=1\n', 'alt1')).toBe('PORT=1\nOA_CLAUDE_ACCOUNTS=default,alt1\n');
  });
  it('appends once', () => {
    const once = addAccountToEnv('OA_CLAUDE_ACCOUNTS=default,alt1\n', 'alt2');
    expect(once).toBe('OA_CLAUDE_ACCOUNTS=default,alt1,alt2\n');
    expect(addAccountToEnv(once, 'alt2')).toBe(once);
    expect(listAccounts(once)).toEqual(['default', 'alt1', 'alt2']);
  });
});

describe('account directory setup', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-cli-acct-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('links shared entries that exist and leaves present ones alone', async () => {
    const main = join(dir, 'main');
    const acct = join(dir, 'acct');
    await mkdir(join(main, 'projects'), { recursive: true });
    await writeFile(join(main, 'settings.json'), '{}');
    await writeFile(join(main, 'CLAUDE.md'), 'x');
    await mkdir(acct, { recursive: true });
    await writeFile(join(acct, 'CLAUDE.md'), 'own');

    expect(linkSharedEntries(main, acct)).toEqual(['projects', 'settings.json']);
    expect(await readlink(join(acct, 'projects'))).toBe(join(main, 'projects'));
    expect((await lstat(join(acct, 'CLAUDE.md'))).isSymbolicLink()).toBe(false);
    expect(linkSharedEntries(main, acct)).toEqual([]);
  });

  it('copies MCP servers only into an account without its own', async () => {
    const mainJson = join(dir, 'main.json');
    const acctJson = join(dir, 'acct.json');
    await writeFile(mainJson, JSON.stringify({ mcpServers: { a: { command: 'x' } }, oauthAccount: { secret: 1 } }));
    await writeFile(acctJson, JSON.stringify({ oauthAccount: { mine: 1 } }));
    expect(copyMcpServers(mainJson, acctJson)).toBe(1);
    const out = JSON.parse(await readFile(acctJson, 'utf8'));
    expect(out).toEqual({ oauthAccount: { mine: 1 }, mcpServers: { a: { command: 'x' } } });
    expect(copyMcpServers(mainJson, acctJson)).toBe(0);
  });
});
