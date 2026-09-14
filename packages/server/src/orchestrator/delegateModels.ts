/**
 * The delegation model catalogue.
 *
 * The orchestrator can hand subtasks to models behind an OpenAI-compatible
 * gateway (LiteLLM or similar). This table names them, gives each a short alias
 * the orchestrator can type, and — the point of the file — an ordered fallback
 * list, so a model that is rate-limited or retired hands the subtask to a peer
 * instead of failing the delegation.
 *
 * Every gateway serves a different set of models, so the catalogue is user
 * configuration: `~/.open-alive/models.json` (or `OA_DELEGATE_MODELS_FILE`)
 * replaces the built-in table below, which is only an example preset written
 * for a LiteLLM gateway that routes Gemini / GLM / Grok / Kimi models.
 * `open-alive setup` writes that file from the gateway's own `/v1/models`.
 *
 * Unknown ids are NOT rejected anywhere — the gateway's catalogue rotates, so an
 * id absent from this table is passed through to the API as-is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Rough role of a model, shown in the orchestrator's menu. */
export type DelegateModelKind = 'reasoning' | 'fast' | 'code' | 'utility';

export interface DelegateModelSpec {
  /** Gateway model id, exactly as `/v1/models` reports it. */
  readonly id: string;
  /** Short names accepted by `--model` (case-insensitive). */
  readonly aliases: readonly string[];
  readonly kind: DelegateModelKind;
  /** One-line capability hint (goes into the orchestrator prompt). */
  readonly note: string;
  /** Ordered alternates tried when this model fails with a retryable error. */
  readonly fallbacks: readonly string[];
}

const GEMINI_LITE = 'gemini/gemini-3.5-flash-lite';
const GEMINI_FLASH = 'gemini/gemini-3.7-flash';
const GEMINI_FLASH_36 = 'gemini/gemini-3.6-flash';
const GEMINI_FLASH_35 = 'gemini/gemini-3.5-flash';
const GEMINI_PRO = 'gemini/gemini-3.1-pro-preview';
const GLM = 'glm-5.3';
const GLM_FLASH = 'glm-5.3-flash';
const GLM_52 = 'glm-5.2';

/** Example preset used when no models.json is configured. */
export const BUILTIN_DELEGATE_MODELS: readonly DelegateModelSpec[] = Object.freeze([
  {
    id: GEMINI_LITE,
    aliases: ['lite', 'flash-lite', 'fast'],
    kind: 'fast',
    note: 'cheapest and fastest — bulk classify / summarize / extract',
    fallbacks: [GEMINI_FLASH_35, GEMINI_FLASH, GLM_FLASH],
  },
  {
    id: GEMINI_FLASH,
    aliases: ['flash', 'gemini'],
    kind: 'fast',
    note: 'general-purpose fast + long context (latest flash)',
    fallbacks: [GEMINI_FLASH_36, GEMINI_FLASH_35, GLM_FLASH],
  },
  {
    id: GEMINI_FLASH_36,
    aliases: ['flash-3.6'],
    kind: 'fast',
    note: 'previous-generation flash (flash substitute)',
    fallbacks: [GEMINI_FLASH, GEMINI_FLASH_35, GLM_FLASH],
  },
  {
    id: GEMINI_FLASH_35,
    aliases: ['flash-3.5'],
    kind: 'fast',
    note: 'older flash (last flash route)',
    fallbacks: [GEMINI_FLASH, GEMINI_FLASH_36, GEMINI_LITE],
  },
  {
    id: GEMINI_PRO,
    aliases: ['pro', 'gemini-pro'],
    kind: 'reasoning',
    note: 'hard reasoning, long analysis',
    fallbacks: [GLM, 'grok-4.5', GEMINI_FLASH],
  },
  {
    id: 'grok-4.5',
    aliases: ['grok'],
    kind: 'reasoning',
    note: 'general reasoning — second opinion from another vendor',
    fallbacks: [GLM, GEMINI_PRO, 'kimi-k3'],
  },
  {
    id: 'kimi-k3',
    aliases: ['kimi', 'k3'],
    kind: 'code',
    note: 'code and agentic work',
    fallbacks: ['kimi-k3-go2', 'kimi-k2.7-code', GLM, GEMINI_PRO],
  },
  {
    id: 'kimi-k3-go2',
    aliases: ['kimi-go2', 'k3-go2'],
    kind: 'code',
    note: 'secondary route for kimi-k3',
    fallbacks: ['kimi-k3', 'kimi-k2.7-code', GLM, GEMINI_PRO],
  },
  {
    id: 'kimi-k2.7-code',
    aliases: ['kimi-code', 'k2-code'],
    kind: 'code',
    note: 'code-specialised (previous generation)',
    fallbacks: ['kimi-k3', GLM, GEMINI_PRO],
  },
  {
    id: GLM,
    aliases: ['glm'],
    kind: 'reasoning',
    note: 'general reasoning + long context (latest GLM)',
    fallbacks: [GLM_52, GEMINI_PRO, 'grok-4.5'],
  },
  {
    id: GLM_FLASH,
    aliases: ['glm-flash'],
    kind: 'fast',
    note: 'fast GLM — cheap bulk work on a non-Gemini route',
    fallbacks: [GLM, GEMINI_FLASH, GEMINI_LITE],
  },
  {
    id: GLM_52,
    aliases: ['glm2', 'glm-5.2'],
    kind: 'reasoning',
    note: 'previous-generation GLM (glm substitute)',
    fallbacks: [GLM, GEMINI_PRO, GEMINI_FLASH],
  },
  {
    id: 'gemma4',
    aliases: ['gemma'],
    kind: 'utility',
    note: 'small local model (ollama)',
    fallbacks: [GEMINI_LITE],
  },
]);

/**
 * Tail used when the requested model is not in the table (a fresh gateway id).
 * Deliberately cross-vendor: whatever went wrong with the unknown id, these are
 * unlikely to share the cause.
 */
export const BUILTIN_FALLBACK_TAIL: readonly string[] = Object.freeze([
  GEMINI_FLASH,
  GLM,
  GEMINI_LITE,
]);

// ── User catalogue (models.json) ─────────────────────────────────────────────

/** Default location of the user's catalogue. */
export const MODELS_FILE = join(homedir(), '.open-alive', 'models.json');

const KINDS: readonly DelegateModelKind[] = ['reasoning', 'fast', 'code', 'utility'];

export interface DelegateCatalog {
  readonly models: readonly DelegateModelSpec[];
  /** Fallbacks for an id that is not in `models`. */
  readonly fallbackTail: readonly string[];
  /** Model used when `--model` is omitted (`OA_DELEGATE_MODEL` still wins). */
  readonly defaultModel?: string;
  /** Review-panel roster (`OA_PANEL_MODELS` still wins). */
  readonly panelModels?: readonly string[];
  /** `builtin` or the file the catalogue was read from. */
  readonly source: string;
}

const BUILTIN_CATALOG: DelegateCatalog = Object.freeze({
  models: BUILTIN_DELEGATE_MODELS,
  fallbackTail: BUILTIN_FALLBACK_TAIL,
  source: 'builtin',
});

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : [];
}

/**
 * Validate a parsed models.json. Returns an error string instead of throwing so
 * the loader can fall back to the built-in preset — a typo in the file must not
 * stop the server from booting.
 *
 * Shape: `{ "models": [{ "id", "aliases"?, "kind"?, "note"?, "fallbacks"? }],
 * "defaultModel"?, "panelModels"?, "fallbackTail"? }`.
 */
export function parseDelegateCatalog(raw: unknown, source: string): DelegateCatalog | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected a JSON object' };
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.models) || obj.models.length === 0) return { error: '"models" must be a non-empty array' };
  const models: DelegateModelSpec[] = [];
  for (const [i, entry] of obj.models.entries()) {
    if (!entry || typeof entry !== 'object') return { error: `models[${i}] must be an object` };
    const m = entry as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id) return { error: `models[${i}].id is required` };
    const kind = KINDS.includes(m.kind as DelegateModelKind) ? (m.kind as DelegateModelKind) : 'utility';
    models.push(Object.freeze({
      id,
      aliases: Object.freeze(stringList(m.aliases)),
      kind,
      note: typeof m.note === 'string' ? m.note : '',
      fallbacks: Object.freeze(stringList(m.fallbacks).filter((f) => f !== id)),
    }));
  }
  const ids = models.map((m) => m.id);
  const tail = stringList(obj.fallbackTail);
  const defaultModel = typeof obj.defaultModel === 'string' && obj.defaultModel.trim() ? obj.defaultModel.trim() : undefined;
  const panelModels = stringList(obj.panelModels);
  return Object.freeze({
    models: Object.freeze(models),
    fallbackTail: Object.freeze(tail.length > 0 ? tail : ids.slice(0, 3)),
    ...(defaultModel ? { defaultModel } : {}),
    ...(panelModels.length > 0 ? { panelModels: Object.freeze(panelModels) } : {}),
    source,
  });
}

/**
 * Load the active catalogue. `OA_DELEGATE_MODELS_FILE=builtin` forces the
 * built-in preset (tests use it so a developer's own models.json cannot leak in).
 */
export function loadDelegateCatalog(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
): DelegateCatalog {
  const configured = env.OA_DELEGATE_MODELS_FILE?.trim();
  if (configured === 'builtin') return BUILTIN_CATALOG;
  const path = configured || MODELS_FILE;
  let text: string;
  try {
    text = read(path);
  } catch {
    return BUILTIN_CATALOG; // no file: the example preset
  }
  try {
    const parsed = parseDelegateCatalog(JSON.parse(text), path);
    if ('error' in parsed) {
      process.stderr.write(`[models] ignoring ${path}: ${parsed.error}\n`);
      return BUILTIN_CATALOG;
    }
    return parsed;
  } catch (error) {
    process.stderr.write(`[models] ignoring ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return BUILTIN_CATALOG;
  }
}

/** The catalogue this process runs with (read once at startup). */
export const ACTIVE_DELEGATE_CATALOG: DelegateCatalog = loadDelegateCatalog();
export const DELEGATE_MODELS: readonly DelegateModelSpec[] = ACTIVE_DELEGATE_CATALOG.models;
export const DEFAULT_FALLBACK_TAIL: readonly string[] = ACTIVE_DELEGATE_CATALOG.fallbackTail;

/** Look a model up by id or alias. Returns undefined for ids not in the table. */
export function findDelegateModel(input: string): DelegateModelSpec | undefined {
  const key = input.trim().toLowerCase();
  if (!key) return undefined;
  return DELEGATE_MODELS.find(
    (m) => m.id.toLowerCase() === key || m.aliases.some((a) => a.toLowerCase() === key),
  );
}

/** Alias → gateway id. Unknown input passes through trimmed (see file header). */
export function resolveModelId(input: string): string {
  return findDelegateModel(input)?.id ?? input.trim();
}

export interface ChainOptions {
  /** `--no-fallback`: use the requested model only. */
  readonly noFallback?: boolean;
  /** `OA_DELEGATE_FALLBACKS` — replaces the table's tail for every model. */
  readonly fallbackOverride?: string;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Build the ordered list of models to try for one delegation.
 *
 * - `requested` may itself be a comma/space separated chain — an explicit chain
 *   is taken literally (no table tail appended); the caller said what it wants.
 * - a single known model contributes its table fallbacks;
 * - a single unknown model gets {@link DEFAULT_FALLBACK_TAIL}.
 */
export function buildDelegateChain(requested: string, opts: ChainOptions = {}): string[] {
  const asked = splitList(requested).map(resolveModelId);
  if (asked.length === 0) return [];
  if (opts.noFallback) return [asked[0]!];
  if (asked.length > 1) return dedupe(asked);

  const primary = asked[0]!;
  const override = opts.fallbackOverride?.trim();
  const tail = override
    ? splitList(override).map(resolveModelId)
    : (findDelegateModel(primary)?.fallbacks ?? DEFAULT_FALLBACK_TAIL);
  return dedupe([primary, ...tail]).filter((id) => id.length > 0);
}

/** The model menu embedded in the orchestrator prompt (one line per model). */
export function describeDelegateModels(): string {
  const label: Record<DelegateModelKind, string> = {
    reasoning: '추론',
    fast: '고속',
    code: '코드',
    utility: '보조',
  };
  return DELEGATE_MODELS.map(
    (m) => `  - ${m.aliases[0] ?? m.id} (${m.id}) [${label[m.kind]}] — ${m.note}`,
  ).join('\n');
}
