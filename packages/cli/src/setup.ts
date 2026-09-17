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
import { existsSync, readFileSync } from 'node:fs';
import {
  upsertEnvValue,
  readEnvKey,
  parseModelIds,
  buildModelsFile,
  writePrivateFile,
} from '@open-alive/core';

import { execFileSync } from 'node:child_process';

export { upsertEnvValue, readEnvKey, parseModelIds, buildModelsFile, writePrivateFile };

export const DEFAULT_PORT = '3141';
export const DEFAULT_GATEWAY_URL = 'http://localhost:4000';

/** Port the server will use: process env, then the env file, then the default. */
export function resolvePort(env: NodeJS.ProcessEnv, envFileText: string): string {
  return env.OPEN_ALIVE_PORT?.trim() || readEnvKey(envFileText, 'OPEN_ALIVE_PORT') || DEFAULT_PORT;
}

export function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
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
