import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessSettings } from '../accessSettings.js';
import { authorizeRequest, type RemoteAccessConfig } from '../remoteAccess.js';

function remoteConfig(trustLoopback: boolean): RemoteAccessConfig {
  return {
    enabled: true,
    host: '0.0.0.0',
    trustLoopback,
    tokens: [{ label: 'phone', value: 'p'.repeat(40) }],
    ticketRoots: ['/work'],
    sshHosts: [],
    terminalLevel: 'off',
  } as RemoteAccessConfig;
}

describe('access settings', () => {
  it('only applies in remote mode; outside it this computer never needs a token', () => {
    const settings = createAccessSettings({ envFile: '/nonexistent/.env', env: {}, config: { enabled: false, trustLoopback: false } });
    expect(settings.get()).toEqual({ remoteEnabled: false, requireTokenLocally: false });
  });

  it('switches the live server and persists OPEN_ALIVE_TRUST_LOOPBACK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'OPEN_ALIVE_PORT=3141\n');
    try {
      const config = remoteConfig(false);
      const env: NodeJS.ProcessEnv = {};
      const settings = createAccessSettings({ envFile, env, config });
      const local = { remoteAddress: '127.0.0.1', headers: { host: 'localhost:3141' }, method: 'GET', pathname: '/api/tickets' };
      expect(authorizeRequest(local, config)).toMatchObject({ kind: 'reject', status: 401 });

      expect(settings.setRequireTokenLocally(false)).toEqual({ remoteEnabled: true, requireTokenLocally: false });
      expect(authorizeRequest(local, config)).toEqual({ kind: 'local' });
      expect(readFileSync(envFile, 'utf-8')).toContain('OPEN_ALIVE_TRUST_LOOPBACK=1');
      expect(readFileSync(envFile, 'utf-8')).toContain('OPEN_ALIVE_PORT=3141');
      expect(env.OPEN_ALIVE_TRUST_LOOPBACK).toBe('1');

      settings.setRequireTokenLocally(true);
      expect(authorizeRequest(local, config)).toMatchObject({ kind: 'reject', status: 401 });
      expect(readFileSync(envFile, 'utf-8')).toContain('OPEN_ALIVE_TRUST_LOOPBACK=0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never lets a remote device through because of it', () => {
    const config = remoteConfig(true);
    const remote = { remoteAddress: '203.0.113.5', headers: {}, method: 'GET', pathname: '/api/tickets' };
    expect(authorizeRequest(remote, config)).toMatchObject({ kind: 'reject', status: 401 });
  });
});
