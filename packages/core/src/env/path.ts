import { homedir } from 'node:os';
import { statSync } from 'node:fs';

/** PATH list separator for a platform (`;` on Windows, `:` elsewhere). */
export function pathDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * Split a list of directories the user wrote in an env var (OPEN_ALIVE_TICKET_ROOTS,
 * OPEN_ALIVE_PANEL_EXCLUDE…). `:` cannot be the separator on Windows, where every
 * absolute path contains one (`C:\…`).
 */
export function splitPathList(raw: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  return (raw ?? '').split(pathDelimiter(platform)).map((s) => s.trim()).filter(Boolean);
}

/**
 * Ensure a child process can find user-installed CLIs (notably `claude`, commonly
 * at ~/.local/bin or ~/.npm-global/bin). When a process runs under launchd its
 * PATH is a minimal system PATH, so a bare `claude` fails with "command not
 * found". Prepend the common user bin dirs (deduped, order-preserving) so
 * resolution works no matter how the process was launched.
 *
 * `home`, `platform` and `env` are injectable for testing.
 *
 * Lives in core because both the server (spawning runtimes) and the CLI
 * (`doctor` probing runtimes) need it — probing with a reduced PATH would report
 * installed runtimes as missing.
 */
export function augmentPath(
  basePath: string | undefined,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const preferred = win
    ? [
        // Claude Code's native installer and npm's global bin on Windows.
        `${home}${sep}.local${sep}bin`,
        env.APPDATA ? `${env.APPDATA}${sep}npm` : `${home}${sep}AppData${sep}Roaming${sep}npm`,
      ]
    : [`${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
  // System essentials, guaranteed present even when the inherited PATH is empty.
  const tail = win ? [] : ['/usr/bin', '/bin'];
  const existing = (basePath ?? '').split(pathDelimiter(platform)).filter(Boolean);
  // Order: user dirs first, then the inherited PATH (order preserved), then
  // system essentials — deduped, first occurrence wins.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of [...preferred, ...existing, ...tail]) {
    const key = win ? p.toLowerCase() : p;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result.join(pathDelimiter(platform));
}

function isAbsoluteFor(dir: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(dir) : dir.startsWith('/');
}

/**
 * Absolute path of an executable on PATH, or null. On Windows a bare name is
 * tried with each PATHEXT extension (`claude` → `claude.exe` / `claude.cmd`).
 */
export function findExecutable(
  bin: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (path: string) => boolean = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
): string | null {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const exts = win
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  for (const dir of (pathValue ?? '').split(pathDelimiter(platform))) {
    // Only absolute entries: an empty or relative entry (`.`) would resolve
    // against the cwd — a ticket's repository — and run whatever it contains.
    if (!isAbsoluteFor(dir, platform)) continue;
    const base = dir.endsWith(sep) || dir.endsWith('/') ? `${dir}${bin}` : `${dir}${sep}${bin}`;
    for (const ext of exts) {
      // On Windows a bare file without an extension is not runnable; require one.
      if (win && ext === '') continue;
      if (isFile(base + ext)) return base + ext;
    }
  }
  return null;
}
