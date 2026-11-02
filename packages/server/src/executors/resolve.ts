/**
 * Pick the Executor for a ticket's location: local child process, or SSH to a
 * remote host. Absent location = local (backward-compatible).
 */
import type { TicketEngine, TicketLocation } from '@open-alive/core';
import type { FlagSupportCache } from '../agentFlags.js';
import { createLocalExecutor } from './localExecutor.js';
import { createSshExecutor } from './sshExecutor.js';
import { createCodexExecutor } from './codexExecutor.js';
import type { CodexModel } from '../codexModels.js';
import type { Executor } from './types.js';

export interface ResolveExecutorDeps {
  /** Allowlist applied to LOCAL tickets (from OPEN_ALIVE_TICKET_ROOTS). */
  localAllowedRoots?: readonly string[];
  /**
   * Shared `--model`/`--effort` capability cache. A fresh Executor is built per
   * spawn, so without a shared cache every run would re-probe the target — an
   * extra SSH round-trip per remote ticket. Keys are per-target, so one cache is
   * safe across locations.
   */
  flagCache?: FlagSupportCache;
  /** Codex catalogue lookup; required to run a ticket whose engine is codex. */
  findCodexModel?: (id: string) => CodexModel | undefined;
}

export function resolveExecutor(
  location: TicketLocation | undefined,
  deps: ResolveExecutorDeps = {},
  engine: TicketEngine = 'claude',
): Executor {
  // Codex runs locally only; the create route refuses codex + ssh.
  if (engine === 'codex') {
    const base = createLocalExecutor({ allowedRoots: deps.localAllowedRoots });
    return createCodexExecutor({ base, findModel: deps.findCodexModel ?? (() => undefined) });
  }
  if (location?.kind === 'ssh' && location.ssh) {
    return createSshExecutor(location.ssh, { ...(deps.flagCache ? { flagCache: deps.flagCache } : {}) });
  }
  return createLocalExecutor({
    allowedRoots: deps.localAllowedRoots,
    ...(deps.flagCache ? { flagCache: deps.flagCache } : {}),
  });
}
