/**
 * SSH connection presets stored in localStorage.
 *
 * Security note: passwords are NEVER stored. The preset only holds the command
 * (e.g. `ssh studio`) — the user still answers any password prompt manually
 * in the pty, or relies on ssh-agent / key-based auth / ~/.ssh/config.
 */

const STORAGE_KEY = 'open-alive:ssh-presets:v1';

export interface SSHPreset {
  id: string;
  label: string;
  command: string;
  /** Optional structured fields — kept for re-editing in the dialog. */
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  autoRun: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SSHPresetDraft {
  label: string;
  command: string;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  autoRun: boolean;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSSHPreset(v: unknown): v is SSHPreset {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.label === 'string' &&
    typeof p.command === 'string' &&
    typeof p.autoRun === 'boolean' &&
    typeof p.createdAt === 'number' &&
    typeof p.updatedAt === 'number'
  );
}

export function loadPresets(): SSHPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSSHPreset);
  } catch {
    return [];
  }
}

/** Fired after presets change so already-mounted views (e.g. the ticket form's
 *  location picker) refresh without a page reload. */
export const SSH_PRESETS_CHANGED = 'ca:ssh-presets-changed';

function persist(presets: SSHPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // localStorage may be full or disabled (private mode) — fail silently.
  }
  try {
    window.dispatchEvent(new Event(SSH_PRESETS_CHANGED));
  } catch {
    // no window (SSR/tests) — nothing to notify.
  }
}

export function createPreset(draft: SSHPresetDraft): SSHPreset {
  const now = Date.now();
  const preset: SSHPreset = {
    id: randomId(),
    label: draft.label.trim(),
    command: draft.command.trim(),
    host: draft.host?.trim() || undefined,
    user: draft.user?.trim() || undefined,
    port: draft.port,
    identityFile: draft.identityFile?.trim() || undefined,
    autoRun: draft.autoRun,
    createdAt: now,
    updatedAt: now,
  };
  const next = [...loadPresets(), preset];
  persist(next);
  return preset;
}

export function updatePreset(id: string, draft: SSHPresetDraft): SSHPreset | null {
  const all = loadPresets();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const existing = all[idx]!;
  const updated: SSHPreset = {
    ...existing,
    label: draft.label.trim(),
    command: draft.command.trim(),
    host: draft.host?.trim() || undefined,
    user: draft.user?.trim() || undefined,
    port: draft.port,
    identityFile: draft.identityFile?.trim() || undefined,
    autoRun: draft.autoRun,
    updatedAt: Date.now(),
  };
  const next = [...all.slice(0, idx), updated, ...all.slice(idx + 1)];
  persist(next);
  return updated;
}

export function deletePreset(id: string): void {
  const next = loadPresets().filter((p) => p.id !== id);
  persist(next);
}

/** Build an `ssh` command string from structured fields. */
export function buildSSHCommand(fields: {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}): string {
  const parts: string[] = ['ssh'];
  if (fields.identityFile && fields.identityFile.trim()) {
    parts.push('-i', shellQuote(fields.identityFile.trim()));
  }
  if (fields.port && fields.port !== 22) {
    parts.push('-p', String(fields.port));
  }
  const target = fields.user?.trim()
    ? `${fields.user.trim()}@${fields.host.trim()}`
    : fields.host.trim();
  parts.push(target);
  return parts.join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@~-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where a preset connects, for running a ticket there over SSH. */
export interface SSHTarget {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** ssh options that take a value (`-p 22`), so their value is not mistaken for the host. */
const SSH_VALUE_FLAGS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
/** A host token: hostname, ssh_config alias, or IPv4/IPv6 — nothing a shell would interpret. */
const HOST_TOKEN = /^[A-Za-z0-9._:-]+$/;

function unquote(token: string): string {
  return token.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

/**
 * The SSH target a preset reaches, or null when it is not a plain `ssh` login.
 *
 * Presets saved with structured fields use them directly. A free-form command
 * (`ssh studio`, `ssh -p 2222 -i ~/.ssh/k dev@box`) is parsed so presets made in
 * the terminal's SSH tab work as ticket locations too. A command that runs
 * something remotely, chains commands, or uses anything but `ssh` is not a login
 * target and stays terminal-only.
 */
export function presetTarget(preset: Pick<SSHPreset, 'command' | 'host' | 'user' | 'port' | 'identityFile'>): SSHTarget | null {
  if (preset.host && preset.host.trim()) {
    return {
      host: preset.host.trim(),
      ...(preset.user ? { user: preset.user } : {}),
      ...(preset.port ? { port: preset.port } : {}),
      ...(preset.identityFile ? { identityFile: preset.identityFile } : {}),
    };
  }
  if (/[;&|`$<>()\n]/.test(preset.command)) return null;
  const tokens = preset.command.trim().split(/\s+/).map(unquote);
  if (tokens[0] !== 'ssh') return null;
  let user: string | undefined;
  let port: number | undefined;
  let identityFile: string | undefined;
  let dest: string | undefined;
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.startsWith('-')) {
      const flag = tok.slice(0, 2);
      const inline = tok.length > 2 ? tok.slice(2) : undefined;
      if (SSH_VALUE_FLAGS.has(flag)) {
        const value = inline ?? tokens[++i];
        if (value === undefined) return null;
        if (flag === '-p') port = Number(value);
        if (flag === '-l') user = value;
        if (flag === '-i') identityFile = value;
      }
      continue;
    }
    if (dest !== undefined) return null; // a remote command follows the host
    dest = tok;
  }
  if (!dest) return null;
  const at = dest.lastIndexOf('@');
  const host = at >= 0 ? dest.slice(at + 1) : dest;
  if (at >= 0) user = dest.slice(0, at);
  if (!HOST_TOKEN.test(host) || (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))) return null;
  return {
    host,
    ...(user ? { user } : {}),
    ...(port ? { port } : {}),
    ...(identityFile ? { identityFile } : {}),
  };
}
