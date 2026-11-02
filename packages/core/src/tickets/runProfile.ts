/**
 * Ticket run profiles — which model and reasoning effort a ticket's agent runs with.
 *
 * The UI exposes a few presets rather than free-form model×effort combinations:
 * the combination space is large, most of it is not useful, and a bad pairing
 * (cheap model + max effort) wastes tokens without improving the result. A preset
 * names a model TIER (sonnet / opus / fable) plus an effort. At creation the tier
 * is resolved to a concrete full model id and that resolution is SNAPSHOTTED onto
 * the ticket — so a later model release never rewrites what an old ticket ran with.
 *
 * Which full id a tier means is not hardcoded: the server asks the local Claude
 * CLI what each alias resolves to right now (see server `claudeModels.ts`) and
 * passes that map in. The constants below are only the fallback for when the CLI
 * cannot be probed. The version that actually served the run is still captured
 * separately from the result stream (`Ticket.model`).
 */

/** Reasoning effort levels accepted by `claude --effort`. */
export const TICKET_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type TicketEffort = (typeof TICKET_EFFORT_LEVELS)[number];

/** Selectable run presets, cheapest first — the picker reads as a cost ramp. */
export const TICKET_RUN_PRESET_IDS = ['fast', 'medium', 'standard', 'deep', 'expert', 'ultimate'] as const;
export type TicketRunPreset = (typeof TICKET_RUN_PRESET_IDS)[number];

/** Model families the CLI is probed for. Each is also a `claude --model` alias. */
export const TICKET_MODEL_TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type TicketModelTier = (typeof TICKET_MODEL_TIERS)[number];

/** Tier → full model id. */
export type TicketModelMap = Readonly<Record<TicketModelTier, string>>;

/**
 * Fallback ids used until the CLI has been probed (or when it cannot be).
 * The live map from the probe replaces these at runtime.
 */
export const TICKET_MODEL_OPUS = 'claude-opus-5-5';
export const TICKET_MODEL_SONNET = 'claude-sonnet-5-5';
export const TICKET_MODEL_FABLE = 'claude-fable-5-1';
export const TICKET_MODEL_HAIKU = 'claude-haiku-5-5';

export const FALLBACK_TICKET_MODELS: TicketModelMap = Object.freeze({
  haiku: TICKET_MODEL_HAIKU,
  sonnet: TICKET_MODEL_SONNET,
  opus: TICKET_MODEL_OPUS,
  fable: TICKET_MODEL_FABLE,
});

/** A full Claude model id as the CLI reports it (`claude-opus-5-5`, `claude-haiku-4-5-20251001`). */
const CLAUDE_MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

export function isClaudeModelId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_MODEL_ID.test(value);
}

/**
 * Display name for a model id: `claude-opus-5-5` → `Opus 5.5`. Ids that do not
 * look like a Claude model id pass through untouched — showing the raw id beats
 * inventing a name for it.
 */
export function modelDisplayName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = CLAUDE_MODEL_ID.exec(model);
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

const MAX_MODEL_CHOICE_LENGTH = 80;
/** `[1m]` is the CLI's long-context suffix (`claude-opus-5-5[1m]`). */
const MODEL_CHOICE = /^(?:claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\[1m\])?|haiku|sonnet|opus|fable)$/;

/**
 * A model the user picked directly for a ticket: a tier alias or a full Claude
 * id. Closed pattern on purpose — the value becomes `--model` argv.
 */
export function isTicketModelChoice(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_MODEL_CHOICE_LENGTH && MODEL_CHOICE.test(value);
}

/** Model + effort a new ticket uses when the user changes nothing. */
export const DEFAULT_TICKET_MODEL_TIER: TicketModelTier = 'opus';
export const DEFAULT_TICKET_EFFORT: TicketEffort = 'high';

/**
 * Shape of a Codex model id (`gpt-5.6-terra`, `codex-mini`). Only the shape is
 * checked here; the server also requires the id to be in the local Codex
 * catalogue before a ticket may use it.
 */
const CODEX_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isCodexModelId(value: unknown): value is string {
  return typeof value === 'string' && CODEX_MODEL_ID.test(value) && !isTicketModelChoice(value);
}

/** Fill tiers missing from a probed map with the fallback ids. */
export function mergeTicketModels(partial: Partial<Record<TicketModelTier, string>> | undefined): TicketModelMap {
  const out = { ...FALLBACK_TICKET_MODELS };
  for (const tier of TICKET_MODEL_TIERS) {
    const id = partial?.[tier];
    if (isClaudeModelId(id)) out[tier] = id;
  }
  return Object.freeze(out);
}

/** A preset resolved to the concrete flags handed to the agent CLI. */
export interface TicketRunProfile {
  /** Model alias or full id for `--model`. */
  model: string;
  /** Reasoning effort for `--effort`. */
  effort: TicketEffort;
}

/** Preset → model tier + effort, the definition that does not age with releases. */
export interface TicketRunPresetSpec {
  tier: TicketModelTier;
  effort: TicketEffort;
}

/**
 * `standard` mirrors the previous implicit behaviour (the global `effortLevel:
 * high` default), so existing tickets and new default-preset tickets stay
 * comparable in the usage dashboard. `medium` is one effort step below it on the
 * same tier. `expert` / `ultimate` sit on the larger Fable tier; they spend
 * subscription usage fastest, so a run that hits the limit is reported as
 * `usage-limit` rather than a generic crash (see server `agentQuotaError.ts`).
 */
export const TICKET_RUN_PRESET_SPECS: Readonly<Record<TicketRunPreset, TicketRunPresetSpec>> = {
  fast: { tier: 'sonnet', effort: 'low' },
  medium: { tier: 'opus', effort: 'medium' },
  standard: { tier: 'opus', effort: 'high' },
  deep: { tier: 'opus', effort: 'max' },
  expert: { tier: 'fable', effort: 'medium' },
  ultimate: { tier: 'fable', effort: 'high' },
};

function presetsFor(models: TicketModelMap): Readonly<Record<TicketRunPreset, TicketRunProfile>> {
  const out = {} as Record<TicketRunPreset, TicketRunProfile>;
  for (const id of TICKET_RUN_PRESET_IDS) {
    const spec = TICKET_RUN_PRESET_SPECS[id];
    out[id] = { model: models[spec.tier], effort: spec.effort };
  }
  return out;
}

/** Presets resolved against the fallback ids. */
export const TICKET_RUN_PRESETS: Readonly<Record<TicketRunPreset, TicketRunProfile>> = presetsFor(FALLBACK_TICKET_MODELS);

export const DEFAULT_TICKET_RUN_PRESET: TicketRunPreset = 'standard';

export function isTicketRunPreset(value: unknown): value is TicketRunPreset {
  return typeof value === 'string' && (TICKET_RUN_PRESET_IDS as readonly string[]).includes(value);
}

export function isTicketEffort(value: unknown): value is TicketEffort {
  return typeof value === 'string' && (TICKET_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve a preset id to its flags. Returns undefined for an unknown id so the
 * caller falls back to the CLI's own defaults rather than guessing — an unknown
 * preset must never silently become an expensive one.
 */
export function resolveRunProfile(
  preset: string | undefined,
  models: TicketModelMap = FALLBACK_TICKET_MODELS,
): TicketRunProfile | undefined {
  if (!isTicketRunPreset(preset)) return undefined;
  const spec = TICKET_RUN_PRESET_SPECS[preset];
  return { model: models[spec.tier], effort: spec.effort };
}
