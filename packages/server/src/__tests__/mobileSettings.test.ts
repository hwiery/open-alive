import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMobileSettings, parseTailscaleStatus, type TailscaleStatus } from '../mobileSettings.js';

let dir: string;
let envFile: string;
const tailscale: TailscaleStatus = { installed: true, running: true, ip: '100.64.0.7', dnsName: 'mac.tail.ts.net' };

function make(config = { enabled: false, host: '127.0.0.1', terminalLevel: 'off' as const, tokens: [] as { label: string; value: string }[] }) {
  let n = 0;
  return {
    config,
    settings: createMobileSettings({
      envFile,
      config,
      port: 3141,
      probeTailscale: async () => tailscale,
      generateToken: () => `tok${++n}`.padEnd(43, 'x'),
      isDirectory: (p) => p === '/work' || p === '/src',
    }),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mobile-'));
  envFile = join(dir, '.env');
  writeFileSync(envFile, 'OPEN_ALIVE_PORT=3141\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('mobile settings', () => {
  it('reports Tailscale, saved config and labels only — never token values', async () => {
    const { settings } = make();
    settings.createToken('phone');
    const view = await settings.get();
    expect(view.tailscale.ip).toBe('100.64.0.7');
    expect(view.tokens).toEqual(['phone']);
    expect(JSON.stringify(view)).not.toContain('tok1');
    expect(view.saved.remoteEnabled).toBe(false);
  });

  it('refuses to save a remote config the server could not boot with', async () => {
    const { settings } = make();
    await expect(settings.update({ remoteEnabled: true, ticketRoots: ['/work'] })).rejects.toThrow(/device token/);
    settings.createToken('phone');
    await expect(settings.update({ remoteEnabled: true, ticketRoots: [] })).rejects.toThrow(/ticket folder/);
    await expect(settings.update({ remoteEnabled: true, ticketRoots: ['relative/dir'] })).rejects.toThrow(/absolute/);
    await expect(settings.update({ remoteEnabled: true, ticketRoots: ['/missing'] })).rejects.toThrow(/does not exist/);
  });

  it('saves remote access, folders and bind address, and says a restart is needed', async () => {
    const { settings } = make();
    settings.createToken('phone');
    const view = await settings.update({ remoteEnabled: true, ticketRoots: ['/work', '/src'], bind: 'tailscale', terminalLevel: 'watch' });
    const env = readFileSync(envFile, 'utf-8');
    expect(env).toContain('OPEN_ALIVE_REMOTE=1');
    expect(env).toMatch(/OPEN_ALIVE_TICKET_ROOTS=\/work[:;]\/src/);
    expect(env).toContain('OPEN_ALIVE_HOST=100.64.0.7');
    expect(env).toContain('OPEN_ALIVE_REMOTE_TERMINAL=watch');
    expect(env).toContain('OPEN_ALIVE_PORT=3141');
    expect(view.saved).toMatchObject({ remoteEnabled: true, bind: 'tailscale', terminalLevel: 'watch' });
    expect(view.restartRequired).toBe(true);
  });

  it('applies new and revoked tokens to the running server at once', async () => {
    const { settings, config } = make({ enabled: true, host: '0.0.0.0', terminalLevel: 'off', tokens: [] });
    const a = settings.createToken('phone');
    settings.createToken('tablet');
    expect(config.tokens.map((t) => t.label)).toEqual(['phone', 'tablet']);
    expect(a.token).toHaveLength(43);
    settings.revokeToken('phone');
    expect(config.tokens.map((t) => t.label)).toEqual(['tablet']);
    expect(readFileSync(envFile, 'utf-8')).not.toContain(a.token);
  });

  it('will not revoke the last token while remote access is on, or make duplicates', async () => {
    const { settings } = make();
    settings.createToken('phone');
    await settings.update({ remoteEnabled: true, ticketRoots: ['/work'] });
    expect(() => settings.revokeToken('phone')).toThrow(/last token/);
    expect(() => settings.createToken('phone')).toThrow(/already exists/);
    expect(() => settings.createToken('my phone')).toThrow(/letters/);
  });

  it('tags refusals with a code and the value at fault, for a translated message', async () => {
    const { settings } = make();
    await expect(settings.update({ remoteEnabled: true, ticketRoots: ['/work'] })).rejects.toMatchObject({ code: 'needToken' });
    settings.createToken('phone');
    await expect(settings.update({ remoteEnabled: true, ticketRoots: [] })).rejects.toMatchObject({ code: 'needRoot' });
    await expect(settings.update({ ticketRoots: ['/missing'] })).rejects.toMatchObject({ code: 'rootMissing', params: { path: '/missing' } });
    expect(() => settings.createToken('phone')).toThrow(expect.objectContaining({ code: 'duplicateLabel', params: { name: 'phone' } }));
  });

  it('offers a restart only under a supervisor', () => {
    expect(make().settings.restart()).toBe(false);
  });
});

describe('parseTailscaleStatus', () => {
  it('reads the IPv4 and MagicDNS name of a running node', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.105.20.8', 'fd7a::1'], DNSName: 'mac.tail1.ts.net.' } })))
      .toEqual({ installed: true, running: true, ip: '100.105.20.8', dnsName: 'mac.tail1.ts.net' });
  });
  it('treats a logged-out node as not running', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { TailscaleIPs: [] } }))).toMatchObject({ running: false, ip: null });
  });
});
