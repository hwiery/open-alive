import { describe, it, expect } from 'vitest';
import { ClaudeTerminal } from '../claudeTerminal.js';

describe('ClaudeTerminal.resize', () => {
  it('ignores a resize that races the pty exit instead of crashing the server', () => {
    const term = new ClaudeTerminal();
    let calls = 0;
    (term as unknown as { ptyProc: unknown }).ptyProc = {
      resize: () => {
        calls += 1;
        throw new Error('ioctl(2) failed, EBADF');
      },
      kill: () => {},
    };
    expect(() => term.resize(120, 40)).not.toThrow();
    expect(calls).toBe(1);
  });

  it('is a no-op before a pty exists', () => {
    expect(() => new ClaudeTerminal().resize(80, 24)).not.toThrow();
  });
});
