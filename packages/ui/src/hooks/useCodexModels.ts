import { useEffect, useState } from 'react';
import { CLAUDE_MODELS_CHANGED_EVENT } from './useClaudeModels.ts';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

export interface CodexModelInfo {
  id: string;
  label: string;
  efforts: string[];
  listed: boolean;
}

function parse(raw: unknown): CodexModelInfo[] {
  const list = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    const c = m as Partial<CodexModelInfo>;
    return typeof c.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(c.id)
      ? [{ id: c.id, label: typeof c.label === 'string' ? c.label : c.id, efforts: Array.isArray(c.efforts) ? c.efforts : [], listed: c.listed === true }]
      : [];
  });
}

/**
 * Codex models the server can run tickets on (empty when Codex is not
 * installed or not logged in). Re-read after any backend check.
 */
export function useCodexModels(): CodexModelInfo[] {
  const [models, setModels] = useState<CodexModelInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/codex/models`);
        if (!res.ok) return;
        const parsed = parse(await res.json());
        if (!cancelled) setModels(parsed);
      } catch {
        // offline or older server: no Codex models
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
