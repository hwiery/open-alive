/**
 * `open-alive setup` — interactive first-run configuration.
 *
 * Everything a new user has to decide lives here, in one pass: the port, the
 * Claude Code hooks, an optional OpenAI-compatible gateway for sub-agent
 * delegation, and macOS autostart. Answers go to `~/.open-alive/.env` (0600)
 * and `~/.open-alive/models.json`, the same files the server already reads, so
 * re-running setup is also how settings are changed later.
 *
 * The pure helpers at the top are exported for tests; `runSetup` owns all I/O.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEFAULT_PORT = '3141';
export const DEFAULT_GATEWAY_URL = 'http://localhost:4000';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envLineKey(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const eq = trimmed.indexOf('=');
  return eq > 0 ? trimmed.slice(0, eq).replace(/^export\s+/, '').trim() : undefined;
}

/**
 * Set `key=value` in env-file text, replacing an existing line in place or
 * appending one. `undefined`/empty removes the key. Other lines are untouched.
 */
export function upsertEnvValue(text: string, key: string, value: string | undefined): string {
  if (!KEY_PATTERN.test(key)) throw new Error(`Invalid env key "${key}"`);
  if (value !== undefined && /[\r\n]/.test(value)) throw new Error(`Value for ${key} must be a single line`);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => envLineKey(line) === key);
  const remove = value === undefined || value === '';
  if (index !== -1) {
    const replacement = remove ? [] : [`${key}=${value}`];
    return [...lines.slice(0, index), ...replacement, ...lines.slice(index + 1)].join('\n');
  }
  if (remove) return text;
  const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  return `${text}${separator}${key}=${value}\n`;
}

/** Read one key from env-file text (first match; one quote layer stripped). */
export function readEnvKey(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (envLineKey(line) !== key) continue;
    const raw = line.slice(line.indexOf('=') + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    return quoted ? quoted[2]! : raw;
  }
  return undefined;
}

/** Port the server will use: process env, then the env file, then the default. */
export function resolvePort(env: NodeJS.ProcessEnv, envFileText: string): string {
  return env.OPEN_ALIVE_PORT?.trim() || readEnvKey(envFileText, 'OPEN_ALIVE_PORT') || DEFAULT_PORT;
}

export function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

/** Model ids from an OpenAI-compatible `GET /v1/models` body (`{ data: [{ id }] }`). */
export function parseModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim());
  return [...new Set(ids)].sort();
}

/**
 * A starter models.json for a freshly discovered gateway: every served model,
 * the chosen default first. Kinds and notes are left generic — the user edits
 * them to steer which model the orchestrator picks for what.
 */
export function buildModelsFile(ids: readonly string[], defaultModel: string): Record<string, unknown> {
  const ordered = [defaultModel, ...ids.filter((id) => id !== defaultModel)];
  return {
    defaultModel,
    models: ordered.map((id) => ({ id, aliases: [], kind: 'utility', note: '', fallbacks: [] })),
  };
}

// ── Interactive runner ───────────────────────────────────────────────────────

interface Prompter {
  ask(question: string, fallback: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  secret(question: string): Promise<string>;
  close(): void;
}

function createPrompter(assumeDefaults: boolean): Prompter {
  // Without a terminal (CI, Docker, `… < /dev/null`) there is nobody to answer:
  // take the defaults instead of waiting on a prompt that can never resolve.
  if (assumeDefaults || !process.stdin.isTTY) {
    if (!assumeDefaults) console.log('(no terminal on stdin — using defaults; pass --yes to silence this)\n');
    return {
      ask: async (_q, fallback) => fallback,
      confirm: async (_q, fallback) => fallback,
      secret: async () => '',
      close: () => {},
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question, fallback) {
      const answer = (await rl.question(`${question} [${fallback}]: `)).trim();
      return answer || fallback;
    },
    async confirm(question, fallback) {
      const answer = (await rl.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
      if (!answer) return fallback;
      return answer === 'y' || answer === 'yes';
    },
    async secret(question) {
      // A second interface whose output swallows keystrokes, so the key is not echoed.
      process.stdout.write(question);
      const muted = new Writable({ write: (_chunk, _enc, done) => done() });
      rl.pause();
      const hidden = createInterface({ input: process.stdin, output: muted, terminal: true });
      const answer = await hidden.question('');
      hidden.close();
      rl.resume();
      process.stdout.write('\n');
      return answer.trim();
    },
    close: () => rl.close(),
  };
}

function commandVersion(cmd: string): string | null {
  try {
    const out = execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    return out.toString().trim().split('\n')[0] ?? '';
  } catch {
    return null;
  }
}

async function fetchModelIds(baseUrl: string, key: string): Promise<{ ids: string[] } | { error: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { ids: parseModelIds(await res.json()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/** Write a config file 0600, refusing to follow a symlink planted at the path. */
export function writePrivateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // lstat, not existsSync: a dangling symlink "does not exist" yet would still be followed.
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    // no file yet
  }
  if (isLink) throw new Error(`${path} is a symlink — refusing to write through it`);
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    process.stderr.write(`  ! could not chmod 600 ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export interface SetupContext {
  envFile: string;
  modelsFile: string;
  installHooks: () => { hookScriptPath: string; settingsPath: string };
  enableAutostart: () => void;
  /** `--yes`: take every default without asking (no gateway, no autostart). */
  assumeDefaults: boolean;
}

export interface SetupResult {
  startNow: boolean;
}

function checkPrerequisites(): void {
  const major = Number(process.versions.node.split('.')[0]);
  console.log('Prerequisites / 필수 조건');
  console.log(`  ${major >= 20 ? '✓' : '✗'} Node.js ${process.versions.node}${major >= 20 ? '' : ' — open-alive needs Node.js 20 or newer'}`);
  const claude = commandVersion('claude');
  console.log(
    claude !== null
      ? `  ✓ Claude Code ${claude}`
      : '  ! Claude Code not found on PATH — install it first: https://docs.anthropic.com/en/docs/claude-code',
  );
  const python = commandVersion('python3');
  console.log(python !== null ? `  ✓ ${python} (Efficio self-evaluation)` : '  • python3 not found — optional, only Efficio needs it');
  console.log('');
}

async function configureGateway(prompter: Prompter, ctx: SetupContext, envText: string): Promise<string> {
  const currentUrl = readEnvKey(envText, 'LITELLM_BASE_URL') || DEFAULT_GATEWAY_URL;
  const baseUrl = await prompter.ask('  Gateway base URL (OpenAI-compatible)', currentUrl);
  const currentKey = readEnvKey(envText, 'LITELLM_KEY') ?? '';
  const typed = await prompter.secret(`  API key (hidden${currentKey ? ', empty keeps the current one' : ''}): `);
  const key = typed || currentKey;

  const probe = await fetchModelIds(baseUrl, key);
  if ('error' in probe) {
    console.log(`  ! Could not list models (${probe.error}). Saved anyway — fix it later with "open-alive setup".`);
  } else if (probe.ids.length === 0) {
    console.log('  ! The gateway answered but listed no models.');
  } else {
    console.log(`  ✓ ${probe.ids.length} models: ${probe.ids.slice(0, 12).join(', ')}${probe.ids.length > 12 ? ', …' : ''}`);
    const fallback = probe.ids[0]!;
    let defaultModel = await prompter.ask('  Default model for delegation', fallback);
    if (!probe.ids.includes(defaultModel)) {
      console.log(`  ! "${defaultModel}" is not served by this gateway; using ${fallback}`);
      defaultModel = fallback;
    }
    const overwrite = !existsSync(ctx.modelsFile) || (await prompter.confirm(`  Overwrite ${ctx.modelsFile}?`, false));
    if (overwrite) {
      writePrivateFile(ctx.modelsFile, JSON.stringify(buildModelsFile(probe.ids, defaultModel), null, 2) + '\n');
      console.log(`  ✓ model catalogue: ${ctx.modelsFile} (edit kinds/notes/fallbacks to taste)`);
    }
  }
  return upsertEnvValue(upsertEnvValue(envText, 'LITELLM_BASE_URL', baseUrl), 'LITELLM_KEY', key || undefined);
}

export async function runSetup(ctx: SetupContext): Promise<SetupResult> {
  console.log('\nopen-alive setup\n');
  checkPrerequisites();
  const prompter = createPrompter(ctx.assumeDefaults);
  try {
    let envText = readText(ctx.envFile);

    const current = resolvePort(process.env, envText);
    let port = await prompter.ask('Dashboard port / 대시보드 포트', current);
    if (!isValidPort(port)) {
      console.log(`  ! "${port}" is not a valid port; keeping ${current}`);
      port = current;
    }
    envText = upsertEnvValue(envText, 'OPEN_ALIVE_PORT', port === DEFAULT_PORT ? undefined : port);

    if (await prompter.confirm('Register Claude Code hooks in ~/.claude/settings.json? (a .backup copy is kept)', true)) {
      try {
        const result = ctx.installHooks();
        console.log(`  ✓ hooks registered (${result.settingsPath})`);
      } catch (err) {
        console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
        console.log('    then run "open-alive install" to register hooks');
      }
    } else {
      console.log('  • skipped — run "open-alive install" later to register hooks');
    }

    if (await prompter.confirm('Connect an LLM gateway for sub-agent delegation? (optional)', false)) {
      envText = await configureGateway(prompter, ctx, envText);
    }

    writePrivateFile(ctx.envFile, envText);
    console.log(`  ✓ settings saved to ${ctx.envFile}`);

    if (process.platform === 'darwin' && (await prompter.confirm('Start open-alive automatically at login? (macOS)', false))) {
      ctx.enableAutostart();
    }

    const startNow = await prompter.confirm('Start the dashboard now?', true);
    console.log(`\nDashboard: http://localhost:${port}   ·   re-run "open-alive setup" any time to change these settings.\n`);
    return { startNow };
  } finally {
    prompter.close();
  }
}
