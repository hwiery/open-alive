import { describe, it, expect } from 'vitest';
import { buildClaudeCommand, terminalLaunch } from '../claudeTerminal.js';
import { delegateWrapper } from '../orchestrator/delegateCli.js';
import { runCli } from '../spawnCli.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('terminal on Windows', () => {
  it('runs claude through PowerShell by absolute path, never the blocked .ps1 shim', () => {
    const cmd = buildClaudeCommand({
      shell: 'powershell',
      claudePath: "C:\\Users\\o'brien\\AppData\\Roaming\\npm\\claude.cmd",
      claudeSessionId: UUID,
      displayName: "Bob's app",
    });
    expect(cmd).toBe(`& 'C:\\Users\\o''brien\\AppData\\Roaming\\npm\\claude.cmd' --session-id ${UUID} -n 'Bob''s app'`);
    expect(terminalLaunch('claude', cmd, 'win32')).toEqual({ file: 'powershell.exe', args: ['-NoLogo', '-Command', cmd] });
    expect(terminalLaunch('shell', '', 'win32')).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] });
  });

  it('keeps the POSIX login shell elsewhere', () => {
    expect(terminalLaunch('claude', 'claude', 'darwin', '/bin/zsh')).toEqual({ file: '/bin/zsh', args: ['-l', '-c', 'claude'] });
    expect(buildClaudeCommand({ displayName: "Bob's app" })).toBe(`claude -n 'Bob'\\''s app'`);
  });
});

describe('delegateWrapper', () => {
  it('is a .cmd that forwards every argument on Windows', () => {
    expect(delegateWrapper('C:\\oa\\delegateCli.js', 'win32')).toEqual({
      name: 'oa-delegate.cmd',
      text: '@echo off\r\nnode "C:\\oa\\delegateCli.js" %*\r\n',
    });
  });
  it('is a sh script elsewhere', () => {
    expect(delegateWrapper('/oa/delegateCli.js', 'linux')).toEqual({
      name: 'oa-delegate',
      text: '#!/bin/sh\nexec node "/oa/delegateCli.js" "$@"\n',
    });
  });
});

describe('runCli', () => {
  it('collects output and exit code, passing an argument with shell metacharacters intact', async () => {
    const arg = 'a & b | "c" $(d)';
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.exit(3)', arg]);
    expect(r).toEqual({ code: 3, stdout: arg, stderr: '' });
  });
  it('rejects for a missing command', async () => {
    await expect(runCli('definitely-not-a-cli-oa', ['--version'])).rejects.toThrow();
  });
});

describe('resolveCli', () => {
  it('returns null for a missing CLI, and running null executes nothing but reports ENOENT', async () => {
    const { resolveCli } = await import('../spawnCli.js');
    expect(resolveCli('definitely-not-a-cli-oa', { PATH: '' })).toBeNull();
    await expect(runCli(null, [])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a headless run of a missing CLI ends as a normal failed outcome', async () => {
    const { spawnCli } = await import('../spawnCli.js');
    const child = spawnCli(null, [], {}, 'claude');
    const events: string[] = [];
    await new Promise<void>((done) => {
      child.on('error', (e: NodeJS.ErrnoException) => events.push(`error:${e.code}`));
      child.on('close', () => {
        events.push('close');
        done();
      });
    });
    expect(events).toEqual(['error:ENOENT', 'close']);
  });
});
