import { describe, it, expect } from 'vitest';
import {
  RUN_PRESET_IDS,
  RUN_PRESET_PREVIEW,
  RUN_PRESET_SPECS,
  DEFAULT_RUN_PRESET,
  FALLBACK_MODELS,
  modelLabel,
  runPresetPreview,
} from '../views/tickets/runPresets.ts';
// Imported by source path on purpose: core's package exports expose only the
// barrel, and importing that here would pull in the Node-only transcript parser.
// `runProfile.ts` is plain constants, so reaching for the file directly is safe
// and lets this test compare the UI mirror against the real table — which is the
// whole point: a mirror that silently drifts shows a model the run never used.
import {
  TICKET_RUN_PRESET_IDS,
  TICKET_RUN_PRESETS,
  TICKET_RUN_PRESET_SPECS,
  FALLBACK_TICKET_MODELS,
  DEFAULT_TICKET_RUN_PRESET,
  modelDisplayName,
  resolveRunProfile,
} from '../../../core/src/tickets/runProfile.ts';

describe('run preset mirror', () => {
  it('lists the same presets in the same order as core', () => {
    expect(RUN_PRESET_IDS).toEqual([...TICKET_RUN_PRESET_IDS]);
  });

  it('uses the same default preset, tiers and fallback ids as core', () => {
    expect(DEFAULT_RUN_PRESET).toBe(DEFAULT_TICKET_RUN_PRESET);
    expect(RUN_PRESET_SPECS).toEqual(TICKET_RUN_PRESET_SPECS);
    expect(FALLBACK_MODELS).toEqual(FALLBACK_TICKET_MODELS);
  });

  it('previews the exact model id and effort each preset actually runs with', () => {
    for (const id of TICKET_RUN_PRESET_IDS) {
      const preview = RUN_PRESET_PREVIEW[id];
      expect(preview.model).toBe(TICKET_RUN_PRESETS[id].model);
      expect(preview.effort).toBe(TICKET_RUN_PRESETS[id].effort);
      expect(preview.modelLabel).toBe(modelDisplayName(preview.model));
      expect(preview.modelLabel).not.toBe(preview.model);
    }
  });

  it('previews what the server will resolve with a probed model map', () => {
    const models = { haiku: 'claude-haiku-6', sonnet: 'claude-sonnet-6', opus: 'claude-opus-6-1', fable: 'claude-fable-6' };
    const preview = runPresetPreview(models);
    for (const id of TICKET_RUN_PRESET_IDS) {
      expect(preview[id].model).toBe(resolveRunProfile(id, models)!.model);
    }
    expect(preview.deep.modelLabel).toBe('Opus 6.1');
  });
});

describe('modelLabel', () => {
  it('derives the display name from the id, matching core', () => {
    for (const id of ['claude-opus-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'gpt-5']) {
      expect(modelLabel(id)).toBe(modelDisplayName(id));
    }
  });

  it('passes empty input through', () => {
    expect(modelLabel(undefined)).toBeUndefined();
    expect(modelLabel('')).toBeUndefined();
  });
});
