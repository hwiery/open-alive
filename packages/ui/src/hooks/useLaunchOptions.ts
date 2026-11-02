import { useEffect, useState } from 'react';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

export interface LocalModelInfo {
  model: string;
  provider: string;
}

export function parseLaunchOptions(raw: unknown): LocalModelInfo | null {
  const local = (raw as { localModel?: unknown } | null)?.localModel as Partial<LocalModelInfo> | null | undefined;
  if (!local || typeof local.model !== 'string' || typeof local.provider !== 'string') return null;
  return { model: local.model, provider: local.provider };
}

/**
 * The local model the server can start Codex on (`OA_LOCAL_MODEL`), or null
 * when none is configured or the server is older than this endpoint.
 */
export function useLocalModel(): LocalModelInfo | null {
  const [local, setLocal] = useState<LocalModelInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/terminal/launch-options`);
        if (!res.ok) return;
        const parsed = parseLaunchOptions(await res.json());
        if (!cancelled) setLocal(parsed);
      } catch {
        // offline or older server: no local preset
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return local;
}
