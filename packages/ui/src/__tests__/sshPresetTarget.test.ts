import { describe, it, expect } from 'vitest';
import { presetTarget } from '../views/chat/sshPresets.ts';

const free = (command: string) => presetTarget({ command });

describe('presetTarget', () => {
  it('uses structured fields when the preset has them', () => {
    expect(presetTarget({ command: 'ssh x', host: 'box', user: 'dev', port: 2222 })).toEqual({ host: 'box', user: 'dev', port: 2222 });
  });

  it('parses free-form ssh logins made in the terminal SSH tab', () => {
    expect(free('ssh studio')).toEqual({ host: 'studio' });
    expect(free('ssh dev@192.0.2.20')).toEqual({ host: '192.0.2.20', user: 'dev' });
    expect(free("ssh -p 2222 -i '~/.ssh/id_ed25519' -l ops build.local")).toEqual({
      host: 'build.local', user: 'ops', port: 2222, identityFile: '~/.ssh/id_ed25519',
    });
    expect(free('ssh -A -o ServerAliveInterval=30 -p2200 box')).toEqual({ host: 'box', port: 2200 });
  });

  it('refuses commands that are not a plain login', () => {
    for (const cmd of ['ssh box uptime', 'ssh box; rm -rf /', 'ssh $(whoami)@box', 'mosh box', 'ssh -p', 'ssh -p 99999 box', 'ssh']) {
      expect(free(cmd)).toBeNull();
    }
  });
});
