/**
 * CodexExecutor — runs a ticket on the local Codex CLI instead of Claude Code.
 *
 * Same cwd rules as the local Claude executor (it delegates `validateCwd`). A
 * requested effort the chosen model does not list is dropped and reported as
 * `--effort`, the same way an unsupported Claude flag is.
 */
import { runHeadlessCodex } from '../codexExec.js';
import { sessionIdReporter } from './sessionReporter.js';
import type { CodexModel } from '../codexModels.js';
import type { Executor, AgentSpawnRequest } from './types.js';

export interface CodexExecutorOptions {
  /** Executor whose cwd validation applies (the local one, with its allowlist). */
  base: Executor;
  /** Catalogue lookup for effort support. */
  findModel: (id: string) => CodexModel | undefined;
  /** Injectable for tests. */
  run?: typeof runHeadlessCodex;
}

export function createCodexExecutor(options: CodexExecutorOptions): Executor {
  const run = options.run ?? runHeadlessCodex;
  return {
    validateCwd: (cwd) => options.base.validateCwd(cwd),
    spawn(req: AgentSpawnRequest) {
      const model = req.run?.model;
      const requestedEffort = req.run?.effort;
      const known = model ? options.findModel(model) : undefined;
      const effortOk = requestedEffort !== undefined && (!known || known.efforts.length === 0 || known.efforts.includes(requestedEffort));
      const effort = effortOk ? requestedEffort : undefined;
      req.onFlagsResolved?.({
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        dropped: requestedEffort && !effortOk ? ['--effort'] : [],
      });
      return run({
        goal: req.goal,
        cwd: req.cwd,
        permissionMode: req.permissionMode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(req.resumeSessionId ? { resumeSessionId: req.resumeSessionId } : {}),
        ...(req.pathPrepend ? { pathPrepend: req.pathPrepend } : {}),
        ...(req.extraEnv ? { extraEnv: req.extraEnv } : {}),
        ...(req.onSessionId ? { onEvent: sessionIdReporter(req.onSessionId) } : {}),
      });
    },
  };
}
