import { useEffect, useState } from 'react';
import type { TicketModelMap } from '@open-alive/core';
import { FALLBACK_MODELS } from '../views/tickets/runPresets.ts';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

/** Fired after a Claude connection check refreshed the server's model map. */
export const CLAUDE_MODELS_CHANGED_EVENT = 'open-alive:claude-models-changed';

const TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

function parseModels(raw: unknown): TicketModelMap | null {
  const models = (raw as { models?: Record<string, unknown> } | null)?.models;
  if (!models) return null;
  const out = { ...FALLBACK_MODELS };
  for (const tier of TIERS) {
    const id = models[tier];
    if (typeof id === 'string' && id.startsWith('claude-')) out[tier] = id;
  }
  return out;
}

/**
 * Tier → model id map the server resolves presets against. Starts with the
 * fallback ids and switches to the server's answer when it arrives, and again
 * whenever a Claude connection check refreshes it.
 */
export function useClaudeModels(): TicketModelMap {
  const [models, setModels] = useState<TicketModelMap>(FALLBACK_MODELS);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/claude/models`);
        if (!res.ok) return;
        const parsed = parseModels(await res.json());
        if (parsed && !cancelled) setModels(parsed);
      } catch {
        // offline or older server: keep the fallback ids
      }
    };
    void load();
    const onChanged = () => void load();
    window.addEventListener(CLAUDE_MODELS_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(CLAUDE_MODELS_CHANGED_EVENT, onChanged);
    };
  }, []);
  return models;
}
