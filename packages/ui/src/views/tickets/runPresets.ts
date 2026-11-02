/**
 * Display mirror of core's run presets.
 *
 * The values are duplicated on purpose: importing a runtime value from the
 * `@open-alive/core` barrel drags in the Node-only transcript parser and breaks
 * the browser bundle, so the UI takes the TYPES from core and keeps the constants
 * local. These strings are for the form preview only — the authoritative pairing
 * is resolved server-side at creation and comes back on the ticket itself
 * (`requestedModel` / `effort`), which is what the detail view renders.
 *
 * A preset names a model tier; which full id the tier means comes from the
 * server (`GET /api/claude/models`, probed from the local CLI). The fallback ids
 * below are used until that answer arrives.
 *
 * KEEP IN SYNC with core's `TICKET_RUN_PRESET_SPECS` / `FALLBACK_TICKET_MODELS`;
 * the runPresets test asserts the shape so a preset added on one side is caught.
 */
import type { TicketModelMap, TicketModelTier, TicketRunPreset } from '@open-alive/core';

export const RUN_PRESET_IDS: readonly TicketRunPreset[] = ['fast', 'medium', 'standard', 'deep', 'expert', 'ultimate'];

export const DEFAULT_RUN_PRESET: TicketRunPreset = 'standard';

export interface RunPresetPreview {
  /** Exact id passed to `--model`, shown on hover so the flag is never hidden. */
  model: string;
  /** Display name of that id — what the picker shows. */
  modelLabel: string;
  effort: string;
}

export const RUN_PRESET_SPECS: Readonly<Record<TicketRunPreset, { tier: TicketModelTier; effort: string }>> = {
  fast: { tier: 'sonnet', effort: 'low' },
  medium: { tier: 'opus', effort: 'medium' },
  standard: { tier: 'opus', effort: 'high' },
  deep: { tier: 'opus', effort: 'max' },
  expert: { tier: 'fable', effort: 'medium' },
  ultimate: { tier: 'fable', effort: 'high' },
};

export const FALLBACK_MODELS: TicketModelMap = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

const CLAUDE_MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

/** `claude-opus-5-5` → `Opus 5.5`; anything else passes through (empty → undefined). */
export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = CLAUDE_MODEL_ID.exec(model);
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

/** Preview of every preset against a tier → id map. */
export function runPresetPreview(models: TicketModelMap = FALLBACK_MODELS): Record<TicketRunPreset, RunPresetPreview> {
  const out = {} as Record<TicketRunPreset, RunPresetPreview>;
  for (const id of RUN_PRESET_IDS) {
    const spec = RUN_PRESET_SPECS[id];
    const model = models[spec.tier];
    out[id] = { model, modelLabel: modelLabel(model) ?? model, effort: spec.effort };
  }
  return out;
}

export const RUN_PRESET_PREVIEW: Record<TicketRunPreset, RunPresetPreview> = runPresetPreview();

/** i18n key for a preset's button label. */
export function runPresetLabelKey(id: TicketRunPreset): string {
  return `tickets.preset.${id}`;
}
