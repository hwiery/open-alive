#!/usr/bin/env node

import { installHooks, uninstallHooks } from '@open-alive/hooks';
import {
  DEFAULT_RUNTIME_PROBES,
  augmentPath,
  formatDoctorReport,
  runDoctor,
  addDeviceToken,
  listDeviceTokens,
  revokeDeviceToken,
  readEnvValue,
  type CommandRunner,
} from '@open-alive/core';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { runSetup, resolvePort, writePrivateFile } from './setup.js';
import { isPortInUse } from './portCheck.js';
import { windowsStartupScript } from './windowsStartup.js';
import {
  accountDir, addAccountToEnv, claudeJsonFor, copyClaudeState, linkSharedEntries, listAccounts,
  mainClaudeDir, validateAccountName,
} from './accounts.js';

const ALIVE_DIR = join(homedir(), '.open-alive');
const PID_FILE = join(ALIVE_DIR, 'server.pid');
const LOG_FILE = join(ALIVE_DIR, 'server.log');
const ENV_FILE = join(ALIVE_DIR, '.env');

/** Say what `copyClaudeState` carried over. */
function reportCopiedState(copied: { mcpServers: number; keys: number; projects: number }): void {
  if (copied.mcpServers > 0) console.log(`Copied ${copied.mcpServers} user MCP server(s).`);
  if (copied.keys > 0) console.log(`Copied ${copied.keys} setup flag(s) (onboarding, seen notices).`);
  if (copied.projects > 0) console.log(`Copied trust and tool approvals for ${copied.projects} folder(s).`);
}

/** Env-file text, or '' when there is no file yet. */
function readEnvFile(): string {
  try {
    return readFileSync(ENV_FILE, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write the env file 0600 (it holds the tokens that stand in for loopback
 * trust), refusing to follow a symlink planted at the path.
 */
function writeEnvFile(text: string): void {
  writePrivateFile(ENV_FILE, text);
}

/**
 * The server's own token, for CLI calls. Once remote mode is on, `/api/status`
 * needs authentication even from this machine — a tunnelled request would
 * otherwise be indistinguishable from this one.
 */
function localToken(): string | undefined {
  return readEnvValue(readEnvFile(), 'OPEN_ALIVE_LOCAL_TOKEN') || undefined;
}

/** Read `--flag value` or `--flag=value` out of argv. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  if (index !== -1 && argv[index + 1] && !argv[index + 1]!.startsWith('-')) return argv[index + 1];
  return undefined;
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0); // check if process exists
    return pid;
  } catch {
    try { unlinkSync(PID_FILE); } catch {}
    return null;
  }
}

/**
 * Resolve the server entry-point script. This CLI runs in two layouts:
 *
 *   1. **Workspace / `npm link`** — `dist/index.js` sits in `packages/cli/dist/`,
 *      so the sibling server lives at `../../server/dist/index.js`.
 *   2. **Published npm bundle** — `cli.js` and `dist/server.js` are produced by
 *      `scripts/build-npm.sh` and placed in the same package root; the layout is
 *      `<root>/cli.js` + `<root>/dist/server.js`.
 *
 * Probe candidate paths in order and return the first that exists. Doing this
 * at runtime is what lets a single CLI source serve both publish targets —
 * the previous design duplicated the entire CLI in `npm/cli-entry.ts` and
 * drifted on every edit (see PR #21/#22 fallout).
 */
function serverEntryPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Workspace: packages/cli/dist/index.js → packages/server/dist/index.js
    resolve(currentDir, '..', '..', 'server', 'dist', 'index.js'),
    // npm bundle: <pkg>/cli.js → <pkg>/dist/server.js
    resolve(currentDir, 'dist', 'server.js'),
    // npm bundle alt: <pkg>/dist/cli.js → <pkg>/dist/server.js (sibling)
    resolve(currentDir, 'server.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Last resort: return the workspace path so the resulting error message
  // points to something a developer can debug.
  return candidates[0]!;
}

// macOS launchd plist for the unified open-alive server. As of D-048+
// the absorbed open-alive-prompt subsystem (prompt API + worker queue) runs
// inside this same Node process, so one plist covers everything.
// KeepAlive is unconditional: launchd respawns the server on any exit, clean
// or not. An explicit `open-alive stop` boots the job out instead of killing
// the process, so stopping still sticks until `start` or the next login.

const LAUNCHD_LABEL = 'com.openalive.server';
const LAUNCHD_FILE = `${homedir()}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildOpenAlivePlist(): string {
  const nodePath = process.execPath;
  const entry = serverEntryPath();
  const logFile = join(ALIVE_DIR, 'autostart-server.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(entry)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(ALIVE_DIR)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(`${homedir()}/.local/bin:${homedir()}/.npm-global/bin:${homedir()}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
`;
}

function uidShell(): string {
  return execFileSync('id', ['-u']).toString().trim();
}

function tryRun(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** Windows: a `.cmd` in the user's Startup folder runs `open-alive start` at login. */
const WINDOWS_STARTUP_FILE = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'open-alive.cmd',
);

function launchdTarget(): string {
  return `gui/${uidShell()}/${LAUNCHD_LABEL}`;
}

/** True when the autostart job is loaded into launchd (running or waiting to respawn). */
function launchdLoaded(): boolean {
  return process.platform === 'darwin' && tryRun('launchctl', ['print', launchdTarget()]);
}

/** Load the installed plist; launchd starts it right away (RunAtLoad). */
function launchdBootstrap(): boolean {
  return process.platform === 'darwin' && existsSync(LAUNCHD_FILE)
    && (tryRun('launchctl', ['bootstrap', `gui/${uidShell()}`, LAUNCHD_FILE])
      || tryRun('launchctl', ['load', '-w', LAUNCHD_FILE]));
}

function windowsAutostart(sub: 'enable' | 'disable' | 'status'): void {
  if (sub === 'enable') {
    mkdirSync(dirname(WINDOWS_STARTUP_FILE), { recursive: true });
    writeFileSync(WINDOWS_STARTUP_FILE, windowsStartupScript(process.execPath, resolve(process.argv[1] ?? '')), 'utf-8');
    console.log(`  ✓ open-alive starts at login (${WINDOWS_STARTUP_FILE})`);
  } else if (sub === 'disable') {
    if (existsSync(WINDOWS_STARTUP_FILE)) {
      unlinkSync(WINDOWS_STARTUP_FILE);
      console.log('  ✓ open-alive autostart removed');
    } else {
      console.log('  • open-alive autostart not installed');
    }
  } else {
    console.log(`  open-alive autostart: installed=${existsSync(WINDOWS_STARTUP_FILE)}`);
  }
}

function openAliveAutostart(sub: 'enable' | 'disable' | 'status'): void {
  if (process.platform === 'win32') {
    windowsAutostart(sub);
    return;
  }
  if (process.platform !== 'darwin') {
    console.log('  • open-alive autostart plist: skipped (macOS and Windows only)');
    return;
  }
  mkdirSync(`${homedir()}/Library/LaunchAgents`, { recursive: true });
  if (sub === 'enable') {
    writeFileSync(LAUNCHD_FILE, buildOpenAlivePlist(), 'utf-8');
    if (!tryRun('launchctl', ['bootstrap', `gui/${uidShell()}`, LAUNCHD_FILE])) {
      tryRun('launchctl', ['load', '-w', LAUNCHD_FILE]);
    }
    console.log(`  ✓ open-alive autostart plist installed at ${LAUNCHD_FILE}`);
  } else if (sub === 'disable') {
    if (existsSync(LAUNCHD_FILE)) {
      tryRun('launchctl', ['bootout', `gui/${uidShell()}/${LAUNCHD_LABEL}`]);
      tryRun('launchctl', ['unload', '-w', LAUNCHD_FILE]);
      try { unlinkSync(LAUNCHD_FILE); } catch {}
      console.log('  ✓ open-alive autostart plist removed');
    } else {
      console.log('  • open-alive autostart plist not installed');
    }
  } else {
    const installed = existsSync(LAUNCHD_FILE);
    const loaded = tryRun('launchctl', ['print', `gui/${uidShell()}/${LAUNCHD_LABEL}`]);
    console.log(`  open-alive autostart: installed=${installed}, loaded=${loaded}`);
  }
}

const command = process.argv[2];
const args = process.argv.slice(3);

/**
 * Open `url` in the user's default browser. Best-effort: errors are swallowed
 * because failing to launch the browser shouldn't crash `start` — the user
 * still has the URL printed in the console as a fallback.
 *
 * Per-platform invocations:
 *   macOS   → `open <url>`
 *   Linux   → `xdg-open <url>` (most distros)
 *   Windows → `cmd /c start "" "<url>"` (quoted to handle URLs with &)
 */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Headless box or missing opener — user can copy the URL from stdout.
  }
}

/** True when `url` is served by an open-alive server (answers /api/status like ours). */
async function isOpenAliveServer(url: string): Promise<boolean> {
  try {
    const token = localToken();
    const res = await fetch(`${url}/api/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: unknown };
    return body.status === 'running';
  } catch {
    return false;
  }
}

/** Start the server detached and open the dashboard (`start`, and the end of `setup`). */
async function startServer(argv: readonly string[]): Promise<void> {
  // `--no-open` skips auto-launching the browser. Default is to open: most
  // users only run `open-alive start` to see the dashboard, so requiring
  // an extra copy-paste step is friction. Power users / CI / headless boxes
  // pass --no-open. Matches the convention of `vite`, `next dev`, etc.
  const noOpen = argv.includes('--no-open');
  const port = resolvePort(process.env, readEnvFile());
  const url = `http://localhost:${port}`;
  // Remote mode is opt-in on the command line as well as in the env file, so
  // "expose this server" is always something someone typed.
  const remote = argv.includes('--remote');
  const host = flagValue(argv, '--host');

  // With autostart installed, launchd owns the server so it is respawned on
  // every exit. Flags like --remote come from ~/.open-alive/.env in that mode.
  if (!readPid() && (launchdLoaded() || launchdBootstrap())) {
    console.log('open-alive server is running under launchd (autostart).');
    console.log(`  Dashboard: ${url}`);
    console.log(`  Logs:      ${join(ALIVE_DIR, 'autostart-server.log')}`);
    if (!noOpen) openBrowser(url);
    return;
  }

  const existingPid = readPid();
  if (existingPid) {
    console.log(`open-alive server is already running (PID: ${existingPid}).`);
    console.log(`  Dashboard: ${url}`);
    if (!noOpen) openBrowser(url);
    return;
  }
  if (await isPortInUse(Number(port))) {
    // A server without our PID file is usually the autostart (launchd) one —
    // if the port answers like open-alive, treat it as already running.
    if (await isOpenAliveServer(url)) {
      console.log('open-alive server is already running (autostart).');
      console.log(`  Dashboard: ${url}`);
      if (!noOpen) openBrowser(url);
      return;
    }
    console.error(`✗ Port ${port} is already in use by another program.`);
    console.error('  Stop that program, or pick another port: OPEN_ALIVE_PORT=<port> in ~/.open-alive/.env');
    console.error('  (re-run "open-alive setup" to change it; hooks read the same file).');
    process.exitCode = 1;
    return;
  }
  mkdirSync(ALIVE_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [serverEntryPath()], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ...(remote ? { OPEN_ALIVE_REMOTE: '1' } : {}),
      ...(host ? { OPEN_ALIVE_HOST: host } : {}),
    },
  });
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  console.log(`open-alive server started in background (PID: ${child.pid}).`);
  console.log(`  Dashboard: ${url}`);
  console.log(`  Logs:      ${LOG_FILE}`);

  // The server refuses to boot on an unsafe remote configuration, and a
  // detached child's exit is invisible — so check, and show why.
  setTimeout(() => {
    if (!readPid()) {
      console.error('\nThe server exited immediately. Last log lines:');
      try {
        console.error(readFileSync(LOG_FILE, 'utf-8').split('\n').slice(-12).join('\n'));
      } catch {
        console.error('  (no log file)');
      }
      process.exit(1);
    }
    // In remote mode the dashboard's own API calls need the local token, and a
    // browser cannot set a header — hand it over in the URL once; the page
    // moves it into localStorage and strips it. Printed as well as opened, so
    // a second browser (or another machine) can be pointed at it.
    const token = remote ? localToken() : undefined;
    const dashboardUrl = token ? `${url}/?token=${encodeURIComponent(token)}` : url;
    if (token) console.log(`  Dashboard (authenticated): ${dashboardUrl}`);
    if (!noOpen) openBrowser(dashboardUrl);
  }, 900);
}

/** Version from the nearest package.json (workspace: packages/cli; npm bundle: package root). */
function cliVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '..', 'package.json'), resolve(here, 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try the next layout
    }
  }
  return 'unknown';
}

switch (command) {
  case 'install': {
    console.log('Installing open-alive hooks...');
    let result: ReturnType<typeof installHooks>;
    try {
      result = installHooks();
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.log(`  ✓ hook script: ${result.hookScriptPath}`);
    console.log(`  ✓ settings:    ${result.settingsPath}`);
    console.log('\nDone! Claude Code will stream events to the unified open-alive server.');
    console.log(`Run "open-alive start" to launch the dashboard on :${resolvePort(process.env, readEnvFile())}.`);
    break;
  }

  case 'setup': {
    const assumeDefaults = args.includes('--yes') || args.includes('-y');
    try {
      const result = await runSetup({
        envFile: ENV_FILE,
        modelsFile: join(ALIVE_DIR, 'models.json'),
        installHooks,
        enableAutostart: () => openAliveAutostart('enable'),
        assumeDefaults,
      });
      if (result.startNow && !args.includes('--no-start')) await startServer(args);
    } catch (error) {
      console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    break;
  }

  case 'version':
  case '--version':
  case '-v': {
    console.log(cliVersion());
    break;
  }

  case 'uninstall': {
    console.log('Removing open-alive hooks...');
    uninstallHooks();
    console.log('  ✓ hooks removed from settings.json');

    if (process.platform === 'darwin' && existsSync(LAUNCHD_FILE)) {
      openAliveAutostart('disable');
    }
    console.log('\nDone. Prompt data is preserved at ~/.open-alive/prompt/.');
    break;
  }

  case 'start': {
    await startServer(args);
    break;
  }

  case 'stop': {
    // KeepAlive would respawn a killed launchd server, so unload the job.
    if (launchdLoaded()) {
      tryRun('launchctl', ['bootout', launchdTarget()]);
      console.log('open-alive server stopped (launchd job unloaded until "open-alive start" or next login).');
      break;
    }
    const pid = readPid();
    if (!pid) {
      console.log('open-alive server is not running.');
      break;
    }
    process.kill(pid, 'SIGINT');
    try { unlinkSync(PID_FILE); } catch {}
    console.log(`open-alive server stopped (PID: ${pid}).`);
    break;
  }

  case 'restart': {
    if (launchdLoaded()) {
      tryRun('launchctl', ['kickstart', '-k', launchdTarget()]);
      console.log('open-alive server restarted (launchd).');
      break;
    }
    const pid = readPid();
    if (pid) {
      process.kill(pid, 'SIGINT');
      try { unlinkSync(PID_FILE); } catch {}
      // Give the old process a moment to release the port.
      await new Promise((r) => setTimeout(r, 1000));
    }
    await startServer(args);
    break;
  }

  case 'status': {
    const port = resolvePort(process.env, readEnvFile());
    const pid = readPid();
    let aliveStatus: unknown = null;
    try {
      // With remote mode on this call needs the token like any other caller.
      const token = localToken();
      const res = await fetch(`http://localhost:${port}/api/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      aliveStatus = res.ok ? await res.json() : { running: false, status: res.status };
    } catch {
      aliveStatus = { running: false };
    }
    console.log(JSON.stringify({ pid, ...((aliveStatus as Record<string, unknown>) ?? {}) }, null, 2));
    break;
  }

  case 'token': {
    const sub = process.argv[3] ?? 'list';
    const text = readEnvFile();
    if (sub === 'list') {
      const tokens = listDeviceTokens(text);
      // Labels only. Printing a value on `list` would put it in scrollback and
      // shell history for every later session.
      console.log(tokens.length === 0 ? 'No device tokens.' : tokens.map((t) => `  ${t.label}`).join('\n'));
      console.log(localToken() ? '\nLocal token: present (used by hooks, CLI and the dashboard).' : '\nLocal token: not yet generated (created on the first remote start).');
      break;
    }
    if (sub === 'new') {
      const label = process.argv[4] ?? 'device';
      const value = randomBytes(32).toString('base64url');
      try {
        writeEnvFile(addDeviceToken(text, label, value));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      console.log(`Device token for "${label}":\n\n  ${value}\n`);
      console.log('Shown once — store it in the app now. It is saved in ~/.open-alive/.env.');
      console.log('Restart the server for it to take effect: open-alive stop && open-alive start --remote');
      break;
    }
    if (sub === 'revoke') {
      const label = process.argv[4];
      if (!label) {
        console.error('Usage: open-alive token revoke <label>');
        process.exit(1);
      }
      const next = revokeDeviceToken(text, label);
      if (next === text) {
        console.error(`No device token labelled "${label}".`);
        process.exit(1);
      }
      writeEnvFile(next);
      console.log(`Revoked "${label}". Restart the server to drop it: open-alive stop && open-alive start --remote`);
      break;
    }
    console.error(`Unknown token subcommand "${sub}". Use new|list|revoke.`);
    process.exit(1);
    break;
  }

  case 'account': {
    const sub = process.argv[3] ?? 'list';
    if (sub === 'list') {
      const names = listAccounts(readEnvFile());
      if (names.length < 2) {
        console.log('Account rotation is off (needs two or more). Add one: open-alive account add <name>');
      }
      for (const entry of names) {
        const [name, explicit] = entry.split('=');
        const dir = explicit ?? (name === 'default' ? null : accountDir(name!));
        let state = 'unknown';
        try {
          const out = execFileSync('claude', ['auth', 'status', '--json'], {
            env: { ...process.env, PATH: augmentPath(process.env.PATH), ...(dir ? { CLAUDE_CONFIG_DIR: dir } : {}) },
            encoding: 'utf8',
            timeout: 20_000,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const s = JSON.parse(out) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
          state = s.loggedIn ? `${s.email ?? 'signed in'}${s.subscriptionType ? ` (${s.subscriptionType})` : ''}` : 'not signed in';
        } catch {
          // `claude` missing or the call failed: leave unknown
        }
        console.log(`  ${name}  ${dir ?? mainClaudeDir()}  ${state}`);
      }
      break;
    }
    if (sub === 'add') {
      const name = process.argv[4];
      const invalid = validateAccountName(name);
      if (invalid) {
        console.error(invalid);
        process.exit(1);
      }
      const dir = accountDir(name!);
      const main = mainClaudeDir();
      const linked = linkSharedEntries(main, dir);
      console.log(`Account dir: ${dir}`);
      if (linked.length > 0) console.log(`Shared from ${main}: ${linked.join(', ')}`);
      console.log('\nSign in with the OTHER Claude account in the browser that opens.\n');
      const login = crossSpawn.sync('claude', ['auth', 'login'], {
        stdio: 'inherit',
        env: { ...process.env, PATH: augmentPath(process.env.PATH), CLAUDE_CONFIG_DIR: dir },
      });
      if (login.status !== 0) {
        console.error('\nSign-in did not finish. Run again: open-alive account add ' + name);
        process.exit(1);
      }
      reportCopiedState(copyClaudeState(claudeJsonFor(process.env.CLAUDE_CONFIG_DIR?.trim() || null), claudeJsonFor(dir)));
      writeEnvFile(addAccountToEnv(readEnvFile(), name!));
      console.log(`\nAdded "${name}" to OA_CLAUDE_ACCOUNTS in ~/.open-alive/.env.`);
      console.log('Check both logins are different accounts: open-alive account list');
      console.log('Restart the server for it to take effect: open-alive restart');
      break;
    }
    if (sub === 'sync') {
      // Re-apply the shared links and copied settings to an account added
      // earlier (or after Claude Code added new state). Never touches the login.
      const name = process.argv[4];
      const invalid = validateAccountName(name);
      if (invalid) {
        console.error(invalid.replace('add', 'sync'));
        process.exit(1);
      }
      const dir = accountDir(name!);
      if (!existsSync(join(dir, '.claude.json'))) {
        console.error(`No signed-in account at ${dir}. Add it first: open-alive account add ${name}`);
        process.exit(1);
      }
      const linked = linkSharedEntries(mainClaudeDir(), dir);
      if (linked.length > 0) console.log(`Shared: ${linked.join(', ')}`);
      reportCopiedState(copyClaudeState(claudeJsonFor(process.env.CLAUDE_CONFIG_DIR?.trim() || null), claudeJsonFor(dir)));
      console.log(`"${name}" is up to date.`);
      break;
    }
    console.error(`Unknown account subcommand "${sub}". Use add <name>|sync <name>|list.`);
    process.exit(1);
    break;
  }

  case 'autostart': {
    const sub = process.argv[3] ?? 'status';
    if (!['enable', 'disable', 'status'].includes(sub)) {
      console.error(`Unknown autostart subcommand "${sub}". Use enable|disable|status.`);
      process.exit(1);
    }
    openAliveAutostart(sub as 'enable' | 'disable' | 'status');
    break;
  }

  case 'doctor': {
    // Probe with the same augmented PATH the server uses to spawn runtimes;
    // under launchd the inherited PATH is minimal and would yield false ENOENTs.
    const probeEnv = { ...process.env, PATH: augmentPath(process.env.PATH) };
    /** Probe a runtime binary; a missing binary rejects with ENOENT → not installed. */
    // cross-spawn so `claude.cmd` / `codex.cmd` shims resolve on Windows.
    const runner: CommandRunner = async (cmd, args) => {
      const r = crossSpawn.sync(cmd, [...args], { timeout: 5_000, env: probeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.error) {
        const err = r.error as NodeJS.ErrnoException;
        return { ok: false, stdout: '', error: err.message, code: err.code };
      }
      if (r.status !== 0) {
        return { ok: false, stdout: r.stdout?.toString() ?? '', error: r.stderr?.toString().trim() || `exit ${r.status}` };
      }
      return { ok: true, stdout: r.stdout?.toString() ?? '' };
    };
    const report = await runDoctor(DEFAULT_RUNTIME_PROBES, runner, Date.now());
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    break;
  }

  case 'logs': {
    try {
      const logs = readFileSync(LOG_FILE, 'utf-8');
      const lines = logs.split('\n');
      const tail = lines.slice(-50).join('\n');
      console.log(tail);
    } catch {
      console.log('No log file found.');
    }
    break;
  }

  default: {
    console.log(`
open-alive — Unified Claude Code dashboard + prompt quality coach

Usage:
  open-alive setup          Interactive first-run setup: port, hooks, optional LLM
                            gateway, autostart (--yes takes defaults, --no-start)
  open-alive install      Install Claude Code hooks (single-entry per event)
  open-alive uninstall    Remove hooks (prompt data preserved at ~/.open-alive/prompt/)
  open-alive start        Start the dashboard server (:3141) and open the UI
                            (pass --no-open to skip browser launch)
                            (--remote opens it to other devices; --host <addr> to pick
                             the interface. Remote mode needs a device token and
                             OPEN_ALIVE_TICKET_ROOTS, or the server refuses to boot.)
  open-alive stop         Stop the server
  open-alive restart      Restart the server (via launchd when autostart is on)
  open-alive status       Show server status
  open-alive token        new <label>|list|revoke <label> — device tokens for
                            remote access from the app
  open-alive account      add <name>|sync <name>|list — extra Claude logins; a ticket whose
                            account runs out of usage resumes on the next one
  open-alive autostart    enable|disable|status — macOS launchd plist
                            (respawns the server on every exit)
  open-alive doctor       Detect installed agent runtimes and adapter status
                            (pass --json for machine-readable output)
  open-alive logs         Show recent server logs
  open-alive version      Print the installed version
`);
  }
}
