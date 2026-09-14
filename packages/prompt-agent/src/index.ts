/**
 * @open-alive/prompt-agent — library exports only.
 *
 * As of D-048+, open-alive-prompt is absorbed into open-alive: the standalone
 * Fastify daemon and pidfile lifecycle are gone. open-alive's server
 * (`@open-alive/server`) imports `createPromptSubsystem` from this
 * package and mounts the read-only Fastify routes onto its shared
 * http.Server, calling `ingest()` directly from the unified hook funnel.
 *
 * `buildAgentServer` is retained for unit tests that exercise the full
 * Fastify pipeline via `fastify.inject()`.
 */
export { createPromptSubsystem } from './subsystem.js';
export type {
  PromptSubsystem,
  PromptSubsystemDeps,
} from './subsystem.js';
export { buildAgentServer } from './server.js';
