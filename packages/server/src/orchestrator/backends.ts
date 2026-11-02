/**
 * Backend registry for the onboarding surface (spec §4).
 *
 * Lists the execution/delegation backends the user can connect and runs live
 * connectivity checks. `claude-local` is the local orchestrator and the one
 * backend everything else depends on, so it is always listed first; its check
 * also refreshes which model ids the Claude tiers mean (see claudeModels.ts).
 * `litellm` is the optional OpenAI-compatible gateway (any provider the user
 * enters — the id is historical). `ssh` is a remote location that is registered and
 * checked per-host in the SSH hosts list, so it is not listed as a backend card
 * (its `check` remains available for direct API callers).
 */
import type { BackendId, BackendStatus } from '@open-alive/core';
import { modelDisplayName } from '@open-alive/core';
import type { LitellmClient } from './litellmClient.js';
import type { ClaudeRefreshResult } from '../claudeModels.js';
import type { CodexRefreshResult } from '../codexModels.js';

export interface BackendRegistryDeps {
  /** Present when a gateway is configured. Prefer `getLitellm` when it can change at runtime. */
  litellm?: LitellmClient;
  /** Current gateway client (re-evaluated per call, so saved settings apply without a restart). */
  getLitellm?: () => LitellmClient | undefined;
  /** Resolve the local `claude` binary; returns null when not found. */
  findClaude?: () => string | null;
  /** Version + model probe run after the binary is found. */
  refreshClaude?: () => Promise<ClaudeRefreshResult>;
  /** Optional second engine: version, login and model list of the Codex CLI. */
  refreshCodex?: () => Promise<CodexRefreshResult>;
}

export interface BackendRegistry {
  list(): BackendStatus[];
  check(id: BackendId): Promise<BackendStatus>;
}

export function createBackendRegistry(deps: BackendRegistryDeps): BackendRegistry {
  const litellm = (): LitellmClient | undefined => (deps.getLitellm ? deps.getLitellm() : deps.litellm);
  function base(id: BackendId): BackendStatus {
    switch (id) {
      case 'claude-local':
        return { id, label: 'Claude (local)', kind: 'orchestrator' };
      case 'codex-local':
        return { id, label: 'Codex (local)', kind: 'orchestrator' };
      case 'litellm':
        return { id, label: 'LLM gateway', kind: 'subagent' };
      case 'ssh':
        return { id, label: 'SSH host', kind: 'location' };
    }
  }

  return {
    list() {
      const items: BackendStatus[] = [base('claude-local')];
      if (deps.refreshCodex) items.push(base('codex-local'));
      if (litellm()) items.push(base('litellm'));
      return items;
    },

    async check(id) {
      const b = base(id);
      if (id === 'claude-local') {
        const path = deps.findClaude?.() ?? null;
        if (!path) return { ...b, connected: false, detail: 'claude not found on PATH' };
        if (!deps.refreshClaude) return { ...b, connected: true, detail: path };
        const r = await deps.refreshClaude();
        if (!r.ok) return { ...b, connected: false, detail: r.error };
        const models = r.snapshot.probed.map((tier) => r.snapshot.models[tier]);
        const names = models.map((m) => modelDisplayName(m)).join(' · ');
        return { ...b, connected: true, models, detail: [r.snapshot.version, names].filter(Boolean).join(' — ') };
      }
      if (id === 'codex-local') {
        if (!deps.refreshCodex) return { ...b, connected: false, detail: 'codex support disabled' };
        const r = await deps.refreshCodex();
        if (!r.ok) return { ...b, connected: false, detail: r.error };
        const listed = r.snapshot.models.filter((m) => m.listed);
        const shown = listed.length > 0 ? listed : r.snapshot.models;
        return {
          ...b,
          connected: true,
          models: shown.map((m) => m.id),
          detail: [r.snapshot.version, shown.map((m) => m.label).join(' · ')].filter(Boolean).join(' — '),
        };
      }
      if (id === 'litellm') {
        const client = litellm();
        if (!client) return { ...b, connected: false, detail: 'gateway not configured' };
        const r = await client.checkConnection();
        return r.ok
          ? { ...b, connected: true, models: r.models, detail: `${r.models?.length ?? 0} models` }
          : { ...b, connected: false, detail: r.error };
      }
      // ssh is validated per-host at ticket time.
      return { ...b, connected: undefined, detail: 'checked per-host when a ticket runs' };
    },
  };
}
