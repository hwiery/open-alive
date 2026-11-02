/**
 * The local Codex CLI as a second ticket engine: is it installed, is it logged
 * in, and which models does it offer right now.
 *
 * The model list comes from the CLI itself (`codex debug models`), so a new
 * Codex model shows up without a code change, exactly like the Claude tiers in
 * claudeModels.ts. The last good answer is cached in
 * `~/.open-alive/codex-models.json`; a successful check is reused for a minute.
 */
import { readFileSync } from 'node:fs';
import { augmentPath, isCodexModelId, writePrivateFile } from '@open-alive/core';
import { runCli } from './spawnCli.js';

export const CODEX_CHECK_TTL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_TEXT = 120;

export interface CodexModel {
  /** Exact id for `codex exec -m`. */
  id: string;
  /** Display name from the catalogue (e.g. "GPT-5.6-Terra"). */
  label: string;
  /** Reasoning efforts this model accepts (`-c model_reasoning_effort=`). */
  efforts: string[];
  /** Shown in Codex's own picker (`visibility: list`); hidden ones stay usable. */
  listed: boolean;
}

export interface CodexSnapshot {
  models: CodexModel[];
  version?: string;
  checkedAt?: number;
}

export type CodexRefreshResult =
  | { ok: true; snapshot: CodexSnapshot }
  | { ok: false; error: string; snapshot: CodexSnapshot };

/** Runs `codex <args>`; resolves stdout. Injectable for tests. */
export type CodexCommand = (bin: string, args: string[]) => Promise<string>;

export interface CodexModelCatalogDeps {
  cacheFile: string;
  findCodex: () => string | null;
  run?: CodexCommand;
  now?: () => number;
  ttlMs?: number;
}

export interface CodexModelCatalog {
  get(): CodexSnapshot;
  /** True when `id` is in the catalogue (listed or hidden). */
  has(id: string): boolean;
  find(id: string): CodexModel | undefined;
  refresh(): Promise<CodexRefreshResult>;
}

const realRun: CodexCommand = async (bin, args) => {
  const r = await runCli(bin, args, { env: { ...process.env, PATH: augmentPath(process.env.PATH) }, timeoutMs: COMMAND_TIMEOUT_MS });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').pop() ?? `exit ${r.code}`);
  return r.stdout;
};

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[^\w .()+:/-]/g, '').trim().slice(0, MAX_TEXT);
  return text || undefined;
}

/** Parse `codex debug models` JSON into the models a ticket may use. */
export function parseCodexModels(raw: unknown): CodexModel[] {
  const list = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  const out: CodexModel[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as Record<string, unknown>;
    const id = m.slug;
    if (!isCodexModelId(id)) continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((l) => (l && typeof l === 'object' ? (l as { effort?: unknown }).effort : undefined))
          .filter((e): e is string => typeof e === 'string' && /^[a-z]{1,16}$/.test(e))
      : [];
    out.push({ id, label: cleanText(m.display_name) ?? id, efforts, listed: m.visibility === 'list' });
  }
  return out;
}

function readCache(path: string): CodexSnapshot | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { models?: unknown; version?: unknown; checkedAt?: unknown };
    const models = Array.isArray(raw.models)
      ? (raw.models as unknown[]).flatMap((m) => {
          const c = m as Partial<CodexModel>;
          return isCodexModelId(c.id)
            ? [{
                id: c.id,
                label: cleanText(c.label) ?? c.id,
                efforts: Array.isArray(c.efforts) ? c.efforts.filter((e) => typeof e === 'string' && /^[a-z]{1,16}$/.test(e)) : [],
                listed: c.listed === true,
              }]
            : [];
        })
      : [];
    if (models.length === 0) return undefined;
    return { models, ...(cleanText(raw.version) ? { version: cleanText(raw.version) } : {}) };
  } catch {
    return undefined;
  }
}

export function createCodexModelCatalog(deps: CodexModelCatalogDeps): CodexModelCatalog {
  const run = deps.run ?? realRun;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? CODEX_CHECK_TTL_MS;
  let snapshot: CodexSnapshot = readCache(deps.cacheFile) ?? { models: [] };
  let lastOk = false;
  let inFlight: Promise<CodexRefreshResult> | null = null;

  async function check(): Promise<CodexRefreshResult> {
    if (lastOk && snapshot.checkedAt !== undefined && now() - snapshot.checkedAt < ttlMs) return { ok: true, snapshot };
    const bin = deps.findCodex();
    if (!bin) return { ok: false, error: 'codex not found on PATH', snapshot };
    const version = cleanText((await run(bin, ['--version'])).split('\n')[0]);
    // `login status` exits non-zero when logged out; its message is the reason.
    try {
      await run(bin, ['login', 'status']);
    } catch (error) {
      lastOk = false;
      return { ok: false, error: `not logged in: ${error instanceof Error ? error.message : String(error)}`, snapshot };
    }
    const models = parseCodexModels(JSON.parse(await run(bin, ['debug', 'models'])));
    if (models.length === 0) return { ok: false, error: 'codex reported no models', snapshot };
    snapshot = { models, ...(version ? { version } : {}), checkedAt: now() };
    lastOk = true;
    try {
      writePrivateFile(deps.cacheFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`[codex] could not cache models: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return { ok: true, snapshot };
  }

  return {
    get: () => snapshot,
    has: (id) => snapshot.models.some((m) => m.id === id),
    find: (id) => snapshot.models.find((m) => m.id === id),
    refresh() {
      inFlight ??= check()
        .catch((error: unknown): CodexRefreshResult => ({
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
