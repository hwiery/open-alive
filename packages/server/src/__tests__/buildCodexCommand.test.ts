import { describe, it, expect } from 'vitest';
import { buildCodexCommand, terminalLaunch } from '../claudeTerminal.js';

describe('buildCodexCommand', () => {
  it('bare command when no options', () => {
    expect(buildCodexCommand({})).toBe('codex');
  });

  it('adds the bypass flag when skipping permissions', () => {
    expect(buildCodexCommand({ skipPermissions: true })).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('invokes the resolved path with & on PowerShell', () => {
    expect(
      buildCodexCommand({ shell: 'powershell', codexPath: 'C:\\npm\\codex.cmd', skipPermissions: true }),
    ).toBe("& 'C:\\npm\\codex.cmd' --dangerously-bypass-approvals-and-sandbox");
  });

  it('runs through the login shell like claude', () => {
    expect(terminalLaunch('codex', 'codex', 'darwin', '/bin/zsh')).toEqual({
      file: '/bin/zsh',
      args: ['-l', '-c', 'codex'],
    });
  });
});
