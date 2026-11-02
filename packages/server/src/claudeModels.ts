/**
 * Which full model id each Claude tier (sonnet / opus / fable) means right now.
 *
 * Ticket presets name a tier, not a version, so a model release must not need a
 * code change. The local `claude` CLI already knows what its aliases resolve to:
 * `claude -p --model opus --output-format stream-json --verbose` prints a
 * `system/init` event carrying the resolved id before it sends anything to the
 * API. The probe reads that one line and kills the process — no prompt is
 * answered. Hooks are disabled for the probe so it does not show up as a session
 * on this dashboard.
 *
 * The probe runs in a fresh private (0700) directory with only the user's own
 * settings and no MCP servers: `os.tmpdir()` itself is shared on Linux, and a
 * `.claude/settings.json` or `.mcp.json` planted there would otherwise be loaded
 * as project config by a process this server starts.
 *
 * The last good result is cached in `~/.open-alive/claude-models.json`, so a
 * restart shows the same models without probing again; a failed probe keeps the
 * previous cache and the core fallback ids fill any tier that was never probed.
 */
import { runCli, spawnCli } from './spawnCli.js';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  augmentPath,
  isClaudeModelId,
  mergeTicketModels,
  writePrivateFile,
  TICKET_MODEL_TIERS,
  type TicketModelMap,
  type TicketModelTier,
} from '@open-alive/core';

export const CLAUDE_PROBE_TIMEOUT_MS = 20_000;
const PROBE_KILL_GRACE_MS = 3_000;
/** A successful check is reused for this long, so reopening Settings does not spawn the CLI again. */
export const CLAUDE_CHECK_TTL_MS = 60_000;
const MAX_VERSION_LENGTH = 120;

/** Removed so the probe does not think it is nested inside a Claude Code session. */
const CLAUDE_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT'];

export interface ClaudeModelsSnapshot {
  models: TicketModelMap;
  /** Tiers whose id came from a probe (the rest are fallback ids). */
  probed: TicketModelTier[];
  /** `claude --version` output of the last successful check. */
  version?: string;
  /** Epoch ms of the last successful probe. */
  checkedAt?: number;
}

export type ClaudeRefreshResult =
  | { ok: true; snapshot: ClaudeModelsSnapshot }
  | { ok: false; error: string; snapshot: ClaudeModelsSnapshot };

export interface ClaudeModelCatalogDeps {
  cacheFile: string;
  /** Absolute path of the `claude` binary, or null when it is not installed. */
  findClaude: () => string | null;
  /** Resolve one alias to its full id. Injectable for tests. */
  probeAlias?: (bin: string, alias: TicketModelTier) => Promise<string>;
  readVersion?: (bin: string) => Promise<string>;
  /** `claude auth status` → logged in? null when the CLI cannot tell (older versions). */
  readAuth?: (bin: string) => Promise<boolean | null>;
  now?: () => number;
  /** Reuse a successful check for this long (default {@link CLAUDE_CHECK_TTL_MS}). */
  ttlMs?: number;
}

export interface ClaudeModelCatalog {
  get(): ClaudeModelsSnapshot;
  current(): TicketModelMap;
  /** Check the CLI (version + every tier). Concurrent calls share one probe. */
  refresh(): Promise<ClaudeRefreshResult>;
}

function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentPath(process.env.PATH) };
  for (const key of CLAUDE_ENV_KEYS) delete env[key];
  return env;
}

/** Spawn the CLI for one alias and return the model id from its init event. */
export function probeClaudeAlias(bin: string, alias: TicketModelTier, timeoutMs = CLAUDE_PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let cwd: string;
    try {
      cwd = mkdtempSync(join(tmpdir(), 'oa-claude-probe-'));
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawnCli(
      bin,
      ['-p', '--model', alias, '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
        '--setting-sources', 'user', '--strict-mcp-config', '--no-session-persistence',
        '--settings', '{"disableAllHooks":true}', 'ok'],
      { cwd, env: probeEnv() },
    );
    let settled = false;
    let stderr = '';
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      // A CLI that ignores SIGTERM must not outlive the probe.
      const hardKill = setTimeout(() => child.kill('SIGKILL'), PROBE_KILL_GRACE_MS);
      hardKill.unref();
      child.once('exit', () => clearTimeout(hardKill));
      rmSync(cwd, { recursive: true, force: true });
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${timeoutMs}ms`))), timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event: { type?: string; subtype?: string; model?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        return;
      }
      if (event.type !== 'system' || event.subtype !== 'init') return;
      const model = event.model;
      finish(() =>
        isClaudeModelId(model) ? resolve(model) : reject(new Error(`unexpected model id in init event: ${String(model)}`)),
      );
    });
    child.on('error', (error) => finish(() => reject(error)));
    // `close`, not `exit`: it fires after stdout is drained, so an init line
    // written just before a fast exit is still read first.
    child.on('close', (code) =>
      finish(() => reject(new Error(stderr.trim().split('\n').pop() || `claude exited (${code}) before reporting a model`))),
    );
  });
}

export async function readClaudeVersion(bin: string): Promise<string> {
  const r = await runCli(bin, ['--version'], { env: probeEnv(), timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
  return r.stdout.trim().split('\n')[0] ?? '';
}

/**
 * `claude auth status` prints JSON with `loggedIn`. The model probe alone cannot
 * tell: the CLI reports its init event (and the model) before it needs a login.
 */
export async function readClaudeAuth(bin: string): Promise<boolean | null> {
  try {
    const r = await runCli(bin, ['auth', 'status'], { env: probeEnv(), timeoutMs: 10_000 });
    const parsed = JSON.parse(r.stdout) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : null;
  } catch {
    return null;
  }
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && /^[\w .()+-]+$/.test(value);
}

function readCache(path: string): ClaudeModelsSnapshot | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ClaudeModelsSnapshot> & {
      models?: Partial<Record<TicketModelTier, string>>;
      probed?: unknown;
    };
    // Only tiers the file says were probed count; the rest of `models` is fallback filler.
    const listed = Array.isArray(raw.probed) ? raw.probed : [];
    const probed = TICKET_MODEL_TIERS.filter((tier) => listed.includes(tier) && isClaudeModelId(raw.models?.[tier]));
    if (probed.length === 0) return undefined;
    const picked = Object.fromEntries(probed.map((tier) => [tier, raw.models![tier]]));
    return {
      models: mergeTicketModels(picked),
      probed,
      ...(isVersion(raw.version) ? { version: raw.version } : {}),
      ...(typeof raw.checkedAt === 'number' ? { checkedAt: raw.checkedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createClaudeModelCatalog(deps: ClaudeModelCatalogDeps): ClaudeModelCatalog {
  const probeAlias = deps.probeAlias ?? ((bin, alias) => probeClaudeAlias(bin, alias));
  const readVersion = deps.readVersion ?? readClaudeVersion;
  const readAuth = deps.readAuth ?? readClaudeAuth;
  const now = deps.now ?? Date.now;
  let snapshot: ClaudeModelsSnapshot = readCache(deps.cacheFile) ?? { models: mergeTicketModels(undefined), probed: [] };
  let inFlight: Promise<ClaudeRefreshResult> | null = null;
  const ttlMs = deps.ttlMs ?? CLAUDE_CHECK_TTL_MS;
  // Set by a successful probe in THIS process; a cached file alone never skips a check.
  let lastOk = false;

  async function run(): Promise<ClaudeRefreshResult> {
    if (snapshot.checkedAt !== undefined && now() - snapshot.checkedAt < ttlMs && lastOk) {
      return { ok: true, snapshot };
    }
    const bin = deps.findClaude();
    if (!bin) return { ok: false, error: 'claude not found on PATH', snapshot };
    let version: string;
    try {
      const raw: string = await readVersion(bin);
      version = raw.slice(0, MAX_VERSION_LENGTH).replace(/[^\w .()+-]/g, '');
    } catch (error) {
      return { ok: false, error: `claude --version failed: ${error instanceof Error ? error.message : String(error)}`, snapshot };
    }
    if ((await readAuth(bin)) === false) {
      lastOk = false;
      return { ok: false, error: 'not logged in — run `claude` and log in (/login)', snapshot: { ...snapshot, version } };
    }
    const results = await Promise.allSettled(TICKET_MODEL_TIERS.map((tier) => probeAlias(bin, tier)));
    const found: Partial<Record<TicketModelTier, string>> = {};
    const errors: string[] = [];
    results.forEach((r, i) => {
      const tier = TICKET_MODEL_TIERS[i]!;
      if (r.status === 'fulfilled') found[tier] = r.value;
      else errors.push(`${tier}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    });
    const probed = TICKET_MODEL_TIERS.filter((tier) => found[tier]);
    if (probed.length === 0) {
      return { ok: false, error: errors.join('; ') || 'no model reported', snapshot: { ...snapshot, version } };
    }
    // Tiers that failed this time keep what the previous probe found.
    const models = mergeTicketModels({ ...snapshot.models, ...found });
    snapshot = { models, probed: [...new Set([...snapshot.probed, ...probed])], version, checkedAt: now() };
    lastOk = true;
    try {
      writePrivateFile(deps.cacheFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`[claude] could not cache models: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return { ok: true, snapshot };
  }

  return {
    get: () => snapshot,
    current: () => snapshot.models,
    refresh() {
      inFlight ??= run()
        .catch((error: unknown): ClaudeRefreshResult => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          snapshot,
        }))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
