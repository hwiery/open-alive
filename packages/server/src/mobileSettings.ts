/**
 * Settings → Mobile: everything a phone needs to reach this dashboard over
 * Tailscale, editable from the dashboard instead of the shell.
 *
 * What lives where:
 * - `~/.open-alive/.env` holds the saved configuration (remote on/off, bind
 *   address, ticket folders, terminal level, device tokens). The server reads
 *   it at boot, so remote on/off, the bind address and the terminal level take
 *   effect after a restart.
 * - Device tokens are also applied to the running server at once (create and
 *   revoke need no restart) — revoking a lost phone must not wait.
 *
 * A token value is returned exactly once, from `createToken`; `get()` only ever
 * lists labels.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  addDeviceToken,
  listDeviceTokens,
  readEnvValue,
  revokeDeviceToken,
  splitPathList,
  pathDelimiter,
  upsertEnvValue,
  writePrivateFile,
} from '@open-alive/core';
import { REMOTE_TERMINAL_LEVELS, parseRemoteTerminalLevel, type RemoteTerminalLevel } from './remoteTerminal.js';

const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

export interface TailscaleStatus {
  /** The `tailscale` CLI was found. */
  installed: boolean;
  /** Logged in and connected (BackendState "Running"). */
  running: boolean;
  ip: string | null;
  /** MagicDNS name, e.g. "my-mac.tail1234.ts.net". */
  dnsName: string | null;
}

export type BindChoice = 'all' | 'tailscale' | 'local';

export interface MobileSettingsView {
  /** What the running server does now. */
  active: { remoteEnabled: boolean; host: string; terminalLevel: RemoteTerminalLevel };
  /** What ~/.open-alive/.env says (applied on the next start). */
  saved: { remoteEnabled: boolean; bind: BindChoice; ticketRoots: string[]; terminalLevel: RemoteTerminalLevel };
  restartRequired: boolean;
  /** A restart can be triggered from the dashboard (the server runs under a supervisor). */
  canRestart: boolean;
  tokens: string[];
  tailscale: TailscaleStatus;
  port: number;
}

export interface MobileSettingsUpdate {
  remoteEnabled?: boolean;
  bind?: BindChoice;
  ticketRoots?: string[];
  terminalLevel?: RemoteTerminalLevel;
}

/** Bad input; the route maps it to 400. `code` and `params` let the UI explain it in the user's language. */
export class MobileSettingsError extends Error {
  readonly name = 'MobileSettingsError';
  constructor(
    message: string,
    readonly code: string,
    readonly params?: Record<string, string>,
  ) {
    super(message);
  }
}

export interface MobileSettingsDeps {
  envFile: string;
  /** The live auth config; tokens are swapped in place. */
  config: { enabled: boolean; host: string; terminalLevel: RemoteTerminalLevel; tokens: ReadonlyArray<{ label: string; value: string }> };
  port: number;
  probeTailscale: () => Promise<TailscaleStatus>;
  /** Present when a supervisor restarts the process after it exits (macOS launchd autostart). */
  restart?: () => void;
  generateToken?: () => string;
  isDirectory?: (path: string) => boolean;
}

export interface MobileSettings {
  get(): Promise<MobileSettingsView>;
  update(input: MobileSettingsUpdate): Promise<MobileSettingsView>;
  createToken(label: string): { label: string; token: string };
  revokeToken(label: string): void;
  restart(): boolean;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

const truthy = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';

export function createMobileSettings(deps: MobileSettingsDeps): MobileSettings {
  const generate = deps.generateToken ?? (() => randomBytes(32).toString('base64url'));
  const isDirectory = deps.isDirectory ?? ((p: string) => existsSync(p) && statSync(p).isDirectory());

  const savedFrom = (text: string, tailscaleIp: string | null) => {
    const host = readEnvValue(text, 'OPEN_ALIVE_HOST')?.trim();
    const bind: BindChoice = !host || host === '0.0.0.0' ? 'all' : host === tailscaleIp ? 'tailscale' : host === '127.0.0.1' ? 'local' : 'all';
    return {
      remoteEnabled: truthy(readEnvValue(text, 'OPEN_ALIVE_REMOTE')),
      bind,
      host: host || '0.0.0.0',
      ticketRoots: splitPathList(readEnvValue(text, 'OPEN_ALIVE_TICKET_ROOTS')),
      terminalLevel: parseRemoteTerminalLevel(readEnvValue(text, 'OPEN_ALIVE_REMOTE_TERMINAL')),
    };
  };

  async function get(): Promise<MobileSettingsView> {
    const text = readText(deps.envFile);
    const tailscale = await deps.probeTailscale();
    const saved = savedFrom(text, tailscale.ip);
    const active = { remoteEnabled: deps.config.enabled, host: deps.config.host, terminalLevel: deps.config.terminalLevel };
    const restartRequired =
      saved.remoteEnabled !== active.remoteEnabled ||
      (saved.remoteEnabled && (saved.host !== active.host || saved.terminalLevel !== active.terminalLevel));
    return {
      active,
      saved: { remoteEnabled: saved.remoteEnabled, bind: saved.bind, ticketRoots: saved.ticketRoots, terminalLevel: saved.terminalLevel },
      restartRequired,
      canRestart: Boolean(deps.restart),
      tokens: listDeviceTokens(text).map((t) => t.label),
      tailscale,
      port: deps.port,
    };
  }

  return {
    get,

    async update(input) {
      let text = readText(deps.envFile);
      const tailscale = await deps.probeTailscale();
      const current = savedFrom(text, tailscale.ip);
      const roots = input.ticketRoots ?? current.ticketRoots;
      for (const root of roots) {
        if (!isAbsolute(root)) throw new MobileSettingsError(`not an absolute path: ${root}`, 'rootNotAbsolute', { path: root });
        if (!isDirectory(root)) throw new MobileSettingsError(`folder does not exist: ${root}`, 'rootMissing', { path: root });
      }
      const remoteEnabled = input.remoteEnabled ?? current.remoteEnabled;
      // The server refuses to boot in remote mode without these, so refuse to save a config it cannot start with.
      if (remoteEnabled && roots.length === 0) throw new MobileSettingsError('remote access needs at least one ticket folder', 'needRoot');
      if (remoteEnabled && listDeviceTokens(text).length === 0) throw new MobileSettingsError('remote access needs a device token — create one first', 'needToken');
      if (input.bind === 'tailscale' && !tailscale.ip) throw new MobileSettingsError('Tailscale is not connected on this computer', 'tailscaleOff');
      if (input.terminalLevel !== undefined && !REMOTE_TERMINAL_LEVELS.includes(input.terminalLevel)) {
        throw new MobileSettingsError('unknown terminal level', 'badTerminalLevel');
      }

      text = upsertEnvValue(text, 'OPEN_ALIVE_REMOTE', remoteEnabled ? '1' : undefined);
      if (input.ticketRoots !== undefined) {
        text = upsertEnvValue(text, 'OPEN_ALIVE_TICKET_ROOTS', roots.length > 0 ? roots.join(pathDelimiter()) : undefined);
      }
      if (input.bind !== undefined) {
        const host = input.bind === 'tailscale' ? tailscale.ip! : input.bind === 'local' ? '127.0.0.1' : undefined;
        text = upsertEnvValue(text, 'OPEN_ALIVE_HOST', host);
      }
      if (input.terminalLevel !== undefined) {
        text = upsertEnvValue(text, 'OPEN_ALIVE_REMOTE_TERMINAL', input.terminalLevel === 'off' ? undefined : input.terminalLevel);
      }
      writePrivateFile(deps.envFile, text);
      return get();
    },

    createToken(label) {
      const name = label.trim();
      if (!LABEL_PATTERN.test(name)) throw new MobileSettingsError('use letters, digits, dot, dash or underscore (max 40)', 'badLabel');
      const text = readText(deps.envFile);
      if (listDeviceTokens(text).some((t) => t.label === name)) throw new MobileSettingsError(`a token named "${name}" already exists`, 'duplicateLabel', { name });
      const token = generate();
      writePrivateFile(deps.envFile, addDeviceToken(text, name, token));
      deps.config.tokens = [...deps.config.tokens, { label: name, value: token }];
      return { label: name, token };
    },

    revokeToken(label) {
      const text = readText(deps.envFile);
      const tokens = listDeviceTokens(text);
      if (!tokens.some((t) => t.label === label)) throw new MobileSettingsError(`no token named "${label}"`, 'unknownToken', { name: label });
      if (truthy(readEnvValue(text, 'OPEN_ALIVE_REMOTE')) && tokens.length === 1) {
        throw new MobileSettingsError('this is the last token while remote access is on — turn remote access off first, or create another token', 'lastToken', { name: label });
      }
      writePrivateFile(deps.envFile, revokeDeviceToken(text, label));
      // Takes effect immediately: a lost phone is locked out now, not at the next restart.
      deps.config.tokens = deps.config.tokens.filter((t) => t.label !== label);
    },

    restart() {
      if (!deps.restart) return false;
      deps.restart();
      return true;
    },
  };
}

/** The macOS app ships its CLI inside the bundle; it is often not on PATH. */
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** Parse `tailscale status --json`. */
export function parseTailscaleStatus(json: string): TailscaleStatus {
  try {
    const s = JSON.parse(json) as { BackendState?: unknown; Self?: { TailscaleIPs?: unknown; DNSName?: unknown } };
    const ips = Array.isArray(s.Self?.TailscaleIPs) ? (s.Self!.TailscaleIPs as unknown[]).filter((ip): ip is string => typeof ip === 'string') : [];
    const ipv4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
    const dns = typeof s.Self?.DNSName === 'string' && s.Self.DNSName ? s.Self.DNSName.replace(/\.$/, '') : null;
    const running = s.BackendState === 'Running';
    return { installed: true, running, ip: running ? ipv4 : null, dnsName: running ? dns : null };
  } catch {
    return { installed: true, running: false, ip: null, dnsName: null };
  }
}

export async function probeTailscaleCli(): Promise<TailscaleStatus> {
  const { findCli, runCli } = await import('./spawnCli.js');
  const bin = findCli('tailscale') ?? (process.platform === 'darwin' && existsSync(MAC_APP_CLI) ? MAC_APP_CLI : null);
  if (!bin) return { installed: false, running: false, ip: null, dnsName: null };
  try {
    const r = await runCli(bin, ['status', '--json'], { timeoutMs: 5_000 });
    return parseTailscaleStatus(r.stdout);
  } catch {
    return { installed: true, running: false, ip: null, dnsName: null };
  }
}
