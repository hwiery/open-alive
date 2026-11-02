import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir } from 'node:fs/promises';
import { isAbsolute, resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { AccessSettings } from './accessSettings.js';
import { MobileSettingsError, type MobileSettings } from './mobileSettings.js';
import { TICKET_RUN_PRESET_IDS, TICKET_EFFORT_LEVELS, isTicketModelChoice, isCodexModelId } from '@open-alive/core';
import type { HookEventPayload, HookEventData, HookEventName } from '@open-alive/core';
import { createStaticHandler } from './staticFiles.js';
import { handleRunRequest } from './runRoutes.js';
import type { RunStore } from './runStore.js';
import { listClaudeSessions } from './claudeSessionIndex.js';
import {
  authorizeRequest,
  createAuthLimiter,
  type AuthLimiter,
  type RemoteAccessConfig,
} from './remoteAccess.js';
import { isCrossSiteRequest } from './httpOrigin.js';
import { readServerVersion } from './serverVersion.js';
import { resolveLocalModel } from './localModel.js';
import { GatewaySettingsValidationError, type GatewaySettings } from './gatewaySettings.js';

const SERVER_VERSION = readServerVersion();

// --- Zod schemas for runtime input validation ---

const HookEventDataSchema = z.object({
  session_id: z.string(),
  hook_event_name: z.string(),
  cwd: z.string().optional().default(''),
  tool_name: z.string().optional(),
  prompt: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  transcript_path: z.string().optional(),
}).passthrough();

const WrappedPayloadSchema = z.object({
  event: z.string(),
  tool: z.string().optional().default('system'),
  session_id: z.string(),
  timestamp: z.number(),
  data: HookEventDataSchema,
});

const GatewayTestBodySchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string().optional(),
});

const GatewaySaveBodySchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  writeModels: z.boolean().optional(),
});

const RenameBodySchema = z.object({
  name: z.string().max(100).nullable(),
});

/**
 * Normalize incoming event payload. Claude Code hook stdin sends raw
 * HookEventData ({ hook_event_name, session_id, ... }). Our wrapped format
 * adds { event, tool, timestamp, data }. Accept both.
 */
function normalizePayload(raw: Record<string, unknown>): HookEventPayload {
  // Try wrapped format first
  const wrapped = WrappedPayloadSchema.safeParse(raw);
  if (wrapped.success) {
    return wrapped.data as unknown as HookEventPayload;
  }

  // Try raw Claude Code hook stdin format
  const rawParsed = HookEventDataSchema.safeParse(raw);
  if (!rawParsed.success) {
    throw new Error('Invalid event payload');
  }

  const data = rawParsed.data as unknown as HookEventData;
  return {
    event: data.hook_event_name as HookEventName,
    tool: data.tool_name ?? 'system',
    session_id: data.session_id,
    timestamp: Date.now(),
    data,
  };
}

export interface HttpRouterOptions {
  onEvent: (payload: HookEventPayload) => void;
  getSnapshot: () => object;
  renameAgent: (sessionId: string, name: string | null) => boolean;
  removeAgent: (sessionId: string) => boolean;
  getStats: () => object;
  /** Durable archive of completed (terminated) sessions, newest first. */
  getCompletedArchive: () => unknown[];
  /**
   * ccusage-style LLM usage records parsed from raw Claude Code transcripts,
   * for the Tools > Data dashboard. Absent when the feature is disabled.
   */
  getUsageRecords?: () => Promise<unknown[]>;
  /** Project-name persistence wiring. */
  getProjectNames: () => Record<string, string>;
  saveProjectName: (cwd: string, name: string) => Promise<void>;
  removeProjectName: (cwd: string) => Promise<void>;
  /** Called after a project name changes so the server can broadcast the new map over WS. */
  onProjectNamesChanged?: () => void;
  /** Path to the UI dist directory. Defaults to ../../ui/dist relative to server dist. */
  uiDistPath?: string;
  /**
   * Optional sub-router for paths owned by the absorbed open-alive-prompt
   * subsystem (`/api/prompts*`, `/api/sessions*`, `/v1/ingest/*`). When
   * present, requests matching those prefixes are delegated to it before
   * the built-in route table is consulted — Fastify mounted on the same
   * http.Server with no second port.
   */
  promptRouter?: (req: IncomingMessage, res: ServerResponse) => void;

  /**
   * Server-owned canonical catalog (§I.5). Absent when the v2 event log could
   * not start, in which case the route reports that explicitly rather than
   * pretending the tree is empty.
   */
  workspaceTree?: () => unknown;

  /** One session's conversation; null when the session is unknown (§F.7). */
  sessionConversation?: (sessionId: string, cursor: number) => unknown | null;

  /** Whether a server-owned terminal exists for the session, and why not (§F.7). */
  sessionTerminal?: (sessionId: string) => unknown;

  /**
   * Ticket dashboard wiring (spec 2026-07-21). Absent when the ticket subsystem
   * is disabled, in which case `/api/tickets*` routes 404.
   */
  /**
   * Run registry (spec 2026-08-28). Absent when the subsystem is disabled, in
   * which case `/api/runs*` falls through to 404.
   */
  runs?: RunStore;

  tickets?: {
    list: () => unknown[];
    create: (input: {
      goal: string;
      cwd: string;
      location?: {
        kind: 'local' | 'ssh';
        ssh?: { host: string; user?: string; port?: number; identityFile?: string };
        label?: string;
      };
      orchestrated?: boolean;
      autoCommit?: boolean;
      panelReview?: boolean;
    }) => Promise<unknown>;
    retry: (id: string) => Promise<unknown | undefined>;
    /** Continue a `decision` ticket with a follow-up prompt. Undefined = unknown id. */
    reply?: (id: string, prompt: string) => Promise<unknown | undefined>;
    cancel: (id: string) => Promise<unknown | undefined>;
    remove: (id: string) => Promise<boolean>;
    /** Validate cwd before creating; returns an error message, or null when valid. */
    validateCwd?: (cwd: string, isRemote: boolean) => string | null;
    /**
     * Extra validation applied only to tickets created by a remote device: the
     * cwd allowlist and the SSH-host policy. Returns an error message, or null.
     */
    validateRemoteCreate?: (input: { cwd: string; location?: { kind: string; ssh?: { host: string } } }) => string | null;
    /** Apply a human good/bad label to a settled ticket. Undefined = unknown id. */
    evaluate?: (
      id: string,
      input: { label: 'good' | 'bad' | 'unrated'; weight?: number; note?: string },
    ) => Promise<unknown | undefined>;
    /** Toggle the bias-reflection gate for a ticket. Undefined = unknown id. */
    setReflected?: (id: string, reflected: boolean) => Promise<unknown | undefined>;
    /** Synthesised RouteGuide (bias) preview for a route (cwd). */
    guideFor?: (route: string) => unknown;
    /** All evaluation records (dataset), newest activity first is up to the caller. */
    listEvaluations?: () => unknown[];
  };

  /** Tier → model id map the ticket presets resolve against (claudeModels.ts). */
  claudeModels?: () => unknown;
  /** Codex models a ticket may run on (codexModels.ts). Absent → codex models are refused. */
  codexModels?: {
    list: () => unknown;
    has: (id: string) => boolean;
  };

  /**
   * Orchestration backend registry (spec 2026-07-22). Absent when disabled.
   * Powers the onboarding surface: list connectable backends + live check.
   */
  backends?: {
    list: () => unknown[];
    check: (id: string) => Promise<unknown | null>;
  };

  /**
   * OpenAI-compatible gateway settings (Settings → Backend). Absent → the
   * `/api/settings/gateway*` routes 404. Local (or full-access token) callers
   * only: it writes the API key to disk.
   */
  gatewaySettings?: GatewaySettings;

  /** "Require a token on this computer" (remote mode only). Local / full-access callers only. */
  accessSettings?: AccessSettings;

  /** Settings → Mobile (remote access, device tokens, Tailscale). Local / full-access callers only. */
  mobileSettings?: MobileSettings;

  /**
   * Local git branch operations for the ticket composer. Absent when the git
   * subsystem is off, in which case `/api/git/*` 404s and the UI hides the
   * branch controls entirely.
   */
  git?: {
    list: (cwd: string) => Promise<unknown>;
    switch: (cwd: string, name: string) => Promise<unknown>;
    create: (cwd: string, name: string, from?: string) => Promise<unknown>;
    remove: (cwd: string, name: string) => Promise<unknown>;
  };

  /**
   * Remote-access policy. Absent = the pre-existing local-only behaviour.
   * Present and enabled, every request needs a token — including the ones that
   * arrive on loopback, because a tunnel makes remote callers look local.
   */
  remoteAccess?: RemoteAccessConfig;
  /** Shared with the /ws upgrade so token guesses on either surface count together. */
  authLimiter?: AuthLimiter;

  /**
   * Projects a remote caller may target, drawn from the ticket-root allowlist.
   * This exists because `/api/fs/browse` must stay closed to remote callers
   * (it reads any directory) while the app still has to offer a cwd to pick.
   */
  remoteProjects?: () => Promise<Array<{ path: string; name: string }>>;

  /** Branches of one allowlisted project, for the same reason as remoteProjects. */
  remoteBranches?: (cwd: string) => Promise<unknown>;

  /** Remote directory listing over SSH, for the ticket's remote folder picker. */
  sshBrowse?: (
    target: { host: string; user?: string; port?: number; identityFile?: string },
    path?: string,
  ) => Promise<unknown>;
}

// A leading `-` is the one character that turns a branch argument into a git
// flag. gitBranches rejects it too (and git itself rejects such a refname), but
// the boundary is where argv-shaped input should stop: an allowlist regex would
// be stricter and also reject the non-ASCII branch names git happily accepts.
const notAFlag = (v: string) => !v.startsWith('-');
const GitBranchBodySchema = z.object({
  cwd: z.string().min(1).refine(isAbsolute, 'cwd must be an absolute path'),
  name: z.string().min(1).max(200).refine(notAFlag, 'branch name must not start with "-"'),
  from: z.string().min(1).max(200).refine(notAFlag, 'start point must not start with "-"').optional(),
});

const ProjectNameBodySchema = z.object({
  cwd: z.string().min(1),
  name: z.string().max(100).nullable(),
});

// Reject values starting with `-` at the boundary: they would be smuggled to
// `ssh` as options (argv flag injection, e.g. `-oProxyCommand=…`). sshExecutor
// re-checks defensively, but the schema is the first line of defence.
const noLeadingDash = /^[^-]/;
const SshTargetSchema = z.object({
  host: z.string().min(1).max(255).regex(noLeadingDash),
  user: z.string().max(64).regex(noLeadingDash).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().max(1024).regex(noLeadingDash).optional(),
});

const TicketLocationSchema = z.object({
  kind: z.enum(['local', 'ssh']),
  ssh: SshTargetSchema.optional(),
  label: z.string().max(120).optional(),
});

/**
 * Local runs pass the goal as an argv element (`claude -p <goal>`), so the cap
 * has to stay well under the OS argument limit (macOS kern.argmax = 1 MiB).
 * 100k chars is ~300 KB even in all-3-byte UTF-8 (Korean), leaving room for the
 * prompt prefix and the rest of the argv. The SSH executor feeds stdin instead
 * and is not bound by this.
 */
const MAX_GOAL_CHARS = 100_000;

const TicketCreateBodySchema = z.object({
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  cwd: z.string().min(1),
  location: TicketLocationSchema.optional(),
  orchestrated: z.boolean().optional(),
  // Opt out of the post-verification auto-commit. Omitted = on.
  autoCommit: z.boolean().optional(),
  // Opt out of the external review panels. Omitted = on.
  panelReview: z.boolean().optional(),
  // Closed enum, never free-form model/effort strings: the values become CLI
  // argv, so the allowlist lives at the boundary rather than downstream.
  preset: z.enum(TICKET_RUN_PRESET_IDS).optional(),
  // A directly chosen model/effort, still closed: a tier alias or a Claude id
  // matching a strict pattern (isTicketModelChoice), and the effort enum.
  model: z
    .string()
    .refine((v) => isTicketModelChoice(v) || isCodexModelId(v), 'model must be a Claude or Codex model id')
    .optional(),
  effort: z.enum(TICKET_EFFORT_LEVELS).optional(),
});

const AccessSettingsBodySchema = z.object({ requireTokenLocally: z.boolean() });

const MobileTokenBodySchema = z.object({ label: z.string().max(40) });
const MobileUpdateBodySchema = z.object({
  remoteEnabled: z.boolean().optional(),
  bind: z.enum(['all', 'tailscale', 'local']).optional(),
  ticketRoots: z.array(z.string().max(1024)).max(20).optional(),
  terminalLevel: z.enum(['off', 'watch', 'input', 'shell']).optional(),
});

const EvaluateBodySchema = z.object({
  label: z.enum(['good', 'bad', 'unrated']),
  weight: z.number().int().min(1).max(5).optional(),
  note: z.string().max(2000).optional(),
  // Omitted, the bias gate follows the label; sent, it wins.
  reflected: z.boolean().optional(),
});

const ReflectBodySchema = z.object({
  reflected: z.boolean(),
});

const MAX_BODY_BYTES = 1_048_576; // 1 MB

/**
 * Policy for an install that never opted into remote access: loopback callers
 * are trusted, everyone else falls through to the per-route gates that answer
 * 403. Identical to the behaviour before remote mode existed.
 */
const REMOTE_DISABLED: RemoteAccessConfig = {
  enabled: false,
  host: '127.0.0.1',
  trustLoopback: false,
  tokens: [],
  ticketRoots: [],
  sshHosts: [],
  terminalLevel: 'off',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * Read a request body, capped at MAX_BODY_BYTES. On overflow the caller gets a
 * 413 (not a destroyed socket, which reaches the client as ECONNRESET and reads
 * like "the server is down"), and the rest of the body is drained so the
 * response can still be flushed. `res` is optional only for callers that have
 * already answered.
 */
function readBody(req: IncomingMessage, res?: ServerResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLen = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return; // draining: keep reading, keep nothing
      totalLen += chunk.length;
      if (totalLen > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        if (res) sendJson(res, 413, { error: `Payload too large (max ${MAX_BODY_BYTES} bytes)` }, req);
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown, req?: IncomingMessage): void {
  // The 413 from readBody answers first; the route's own catch must not follow it.
  if (res.headersSent || res.writableEnded) return;
  const origin = req?.headers.origin;
  const allowedOrigin = isLocalOrigin(origin) ? (origin ?? 'http://localhost') : '';
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(data));
}

export function createHttpServer(options: HttpRouterOptions) {
  const {
    onEvent,
    getSnapshot,
    renameAgent,
    removeAgent,
    getStats,
    getCompletedArchive,
    getUsageRecords,
    getProjectNames,
    saveProjectName,
    removeProjectName,
    onProjectNamesChanged,
    uiDistPath,
    promptRouter,
    workspaceTree,
    sessionConversation,
    sessionTerminal,
    runs,
    tickets,
    backends,
    claudeModels,
    codexModels,
    gatewaySettings,
    accessSettings,
    mobileSettings,
    git,
    sshBrowse,
    remoteAccess,
    remoteProjects,
    remoteBranches,
  } = options;
  const serveStatic = createStaticHandler(uiDistPath);
  const accessPolicy = remoteAccess ?? REMOTE_DISABLED;
  // One limiter per server instance: the counter is what makes online token
  // guessing expensive, and it has to outlive individual requests.
  const authLimiter = options.authLimiter ?? createAuthLimiter();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Preflight carries no Authorization by definition, so it is answered
    // before the gate; it reveals nothing a 401 would not.
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, null, req);
      return;
    }

    // Ahead of the access gate: a loopback caller is only "the user" if it is
    // not a web page acting through the user's browser (see httpOrigin.ts).
    if (
      isCrossSiteRequest({
        headers: req.headers,
        method: req.method ?? 'GET',
        pathname: url.pathname,
        loopbackOnly: !accessPolicy.enabled,
      })
    ) {
      sendJson(res, 403, { error: 'Cross-origin request refused' }, req);
      return;
    }

    // The access gate sits ahead of every route *and* ahead of the prompt
    // delegation below. Placing it after would leave `/api/prompts`,
    // `/api/sessions` and `/v1/ingest/*` — prompt text and a write path —
    // outside the policy entirely, since those return before the route table.
    const auth = authorizeRequest(
      {
        method: req.method ?? 'GET',
        pathname: url.pathname,
        headers: req.headers,
        remoteAddress: req.socket.remoteAddress,
        searchToken: url.searchParams.get('token') ?? undefined,
      },
      accessPolicy,
      authLimiter,
    );
    if (auth.kind === 'reject') {
      sendJson(res, auth.status, { error: auth.error }, req);
      return;
    }
    // What the per-route loopback checks below now ask. A remote caller only
    // gets here after clearing the route allowlist, so those checks must not
    // reject it a second time. `public` is the unauthenticated dashboard shell
    // and buys nothing beyond the static handler.
    const sensitiveAllowed = auth.kind === 'local' || auth.kind === 'token';
    const remoteCaller = auth.kind === 'token' && !auth.fullAccess;

    // Delegate prompt-subsystem paths to the mounted Fastify router.
    // These paths are exclusively owned by the absorbed open-alive-prompt code
    // (read-only JSON API + browser-extension ingest); the built-in router
    // never registers them, so there is no overlap risk.
    if (
      promptRouter &&
      (url.pathname.startsWith('/api/prompts') ||
        url.pathname.startsWith('/api/sessions') ||
        url.pathname.startsWith('/v1/ingest/'))
    ) {
      promptRouter(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/event') {
      try {
        const body = await readBody(req, res);
        const raw = JSON.parse(body) as Record<string, unknown>;
        const payload = normalizePayload(raw);
        onEvent(payload);
        sendJson(res, 200, { ok: true }, req);
      } catch {
        sendJson(res, 400, { error: 'Invalid payload' }, req);
      }
      return;
    }

    // v2 read model. Separate from /api/status (v1) so the two can be compared
    // during the dual-write period instead of one silently replacing the other.
    if (req.method === 'GET' && url.pathname === '/api/v2/workspace-tree') {
      if (!workspaceTree) {
        sendJson(res, 503, { error: 'canonical event log unavailable', detail: 'see server logs' }, req);
        return;
      }
      sendJson(res, 200, workspaceTree(), req);
      return;
    }

    const terminalMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/terminal$/);
    if (req.method === 'GET' && terminalMatch) {
      if (!sessionTerminal) {
        sendJson(res, 503, { error: 'canonical event log unavailable', detail: 'see server logs' }, req);
        return;
      }
      sendJson(res, 200, sessionTerminal(decodeURIComponent(terminalMatch[1])), req);
      return;
    }

    const conversationMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/conversation$/);
    if (req.method === 'GET' && conversationMatch) {
      if (!sessionConversation) {
        sendJson(res, 503, { error: 'canonical event log unavailable', detail: 'see server logs' }, req);
        return;
      }
      const cursor = Number(url.searchParams.get('cursor') ?? '0');
      const page = sessionConversation(
        decodeURIComponent(conversationMatch[1]),
        Number.isFinite(cursor) ? cursor : 0,
      );
      if (!page) {
        sendJson(res, 404, { error: 'unknown session' }, req);
        return;
      }
      sendJson(res, 200, page, req);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, {
        status: 'running',
        version: SERVER_VERSION,
        uptime: process.uptime(),
        ...getSnapshot(),
      }, req);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/agents') {
      const snapshot = getSnapshot() as { agents?: unknown };
      sendJson(res, 200, snapshot.agents ?? [], req);
      return;
    }

    // PUT /api/agents/:id/name — rename an agent
    const renameMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/name$/);
    if (req.method === 'PUT' && renameMatch) {
      try {
        const body = await readBody(req, res);
        const parsed = RenameBodySchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          sendJson(res, 400, { error: 'Invalid body: name must be a string (max 100 chars) or null' }, req);
          return;
        }
        const ok = renameAgent(renameMatch[1]!, parsed.data.name);
        sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Agent not found' }, req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' }, req);
      }
      return;
    }

    // DELETE /api/agents/:id — remove an agent
    const deleteMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const ok = removeAgent(deleteMatch[1]!);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Agent not found' }, req);
      return;
    }

    // ── Run registry (spec 2026-08-28) ──────────────────────────────────────
    // Same loopback restriction as tickets: closing a run writes to disk.
    if (runs && url.pathname.startsWith('/api/runs')) {
      if (!sensitiveAllowed) {
        sendJson(res, 403, { error: 'Run API is restricted to loopback' }, req);
        return;
      }
      let parsedBody: unknown = null;
      if (req.method === 'POST') {
        try {
          parsedBody = JSON.parse(await readBody(req, res));
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON' }, req);
          return;
        }
      }
      const runResult = await handleRunRequest(runs, req.method ?? 'GET', url.pathname, parsedBody);
      if (runResult) {
        sendJson(res, runResult.status, runResult.body, req);
        return;
      }
    }

    // ── Ticket dashboard (spec 2026-07-21) ──────────────────────────────────
    // These routes drive RCE-equivalent autonomous agents → loopback callers only.
    if (tickets && url.pathname.startsWith('/api/tickets') && !sensitiveAllowed) {
      sendJson(res, 403, { error: '티켓 API 는 로컬(loopback) 호출만 허용됩니다' }, req);
      return;
    }
    if (tickets && req.method === 'GET' && url.pathname === '/api/tickets') {
      sendJson(res, 200, { tickets: tickets.list() }, req);
      return;
    }
    if (tickets && req.method === 'POST' && url.pathname === '/api/tickets') {
      try {
        const parsed = TicketCreateBodySchema.safeParse(JSON.parse(await readBody(req, res)));
        if (!parsed.success) {
          sendJson(res, 400, { error: '요청 형식 오류: goal 과 cwd 가 필요합니다' }, req);
          return;
        }
        // A non-Claude model means the Codex engine: it must be in the local
        // Codex catalogue, and Codex runs on this machine only.
        const model = parsed.data.model;
        if (model && !isTicketModelChoice(model)) {
          if (!codexModels?.has(model)) {
            sendJson(res, 400, { error: `Codex 모델을 찾을 수 없습니다: ${model}` }, req);
            return;
          }
          if (parsed.data.location?.kind === 'ssh') {
            sendJson(res, 400, { error: 'Codex 티켓은 이 컴퓨터에서만 실행할 수 있습니다' }, req);
            return;
          }
        }
        const cwdError = tickets.validateCwd?.(parsed.data.cwd, parsed.data.location?.kind === 'ssh');
        if (cwdError) {
          sendJson(res, 400, { error: cwdError }, req);
          return;
        }
        // A device token may only start an agent where the operator said it
        // could. Checked at create time, not at spawn time, so the app gets a
        // real error instead of a ticket that fails minutes later.
        if (remoteCaller) {
          const remoteError = tickets.validateRemoteCreate?.(parsed.data);
          if (remoteError) {
            sendJson(res, 400, { error: remoteError }, req);
            return;
          }
        }
        const ticket = await tickets.create(parsed.data);
        sendJson(res, 201, { ticket }, req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' }, req);
      }
      return;
    }
    const ticketRetryMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/retry$/);
    if (tickets && req.method === 'POST' && ticketRetryMatch) {
      const ticket = await tickets.retry(ticketRetryMatch[1]!);
      sendJson(res, ticket ? 200 : 404, ticket ? { ticket } : { error: '티켓을 찾을 수 없습니다' }, req);
      return;
    }
    const ticketCancelMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/cancel$/);
    if (tickets && req.method === 'POST' && ticketCancelMatch) {
      const ticket = await tickets.cancel(ticketCancelMatch[1]!);
      sendJson(res, ticket ? 200 : 404, ticket ? { ticket } : { error: '티켓을 찾을 수 없습니다' }, req);
      return;
    }
    // POST /api/tickets/:id/reply — follow-up prompt for a decision ticket.
    const ticketReplyMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/reply$/);
    if (tickets?.reply && req.method === 'POST' && ticketReplyMatch) {
      try {
        const parsed = JSON.parse(await readBody(req, res)) as { prompt?: unknown };
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
        if (!prompt) {
          sendJson(res, 400, { error: '요청 형식 오류: prompt 가 필요합니다' }, req);
          return;
        }
        const ticket = await tickets.reply(ticketReplyMatch[1]!, prompt);
        sendJson(res, ticket ? 200 : 404, ticket ? { ticket } : { error: '티켓을 찾을 수 없습니다' }, req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' }, req);
      }
      return;
    }
    // POST /api/tickets/:id/evaluate — human good/bad label. Under the /api/tickets
    // prefix so the loopback guard above already applies.
    const ticketEvalMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/evaluate$/);
    if (tickets?.evaluate && req.method === 'POST' && ticketEvalMatch) {
      try {
        const parsed = EvaluateBodySchema.safeParse(JSON.parse(await readBody(req, res)));
        if (!parsed.success) {
          sendJson(res, 400, { error: '요청 형식 오류: label 은 good|bad|unrated 중 하나여야 합니다' }, req);
          return;
        }
        const evaluation = await tickets.evaluate(ticketEvalMatch[1]!, parsed.data);
        sendJson(res, evaluation ? 200 : 404, evaluation ? { evaluation } : { error: '티켓을 찾을 수 없습니다' }, req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' }, req);
      }
      return;
    }
    // POST /api/tickets/:id/reflect — toggle the bias-reflection gate (opt-in).
    // Only reflected tickets shape the route's RouteGuide (spec 2026-07-22).
    const ticketReflectMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)\/reflect$/);
    if (tickets?.setReflected && req.method === 'POST' && ticketReflectMatch) {
      try {
        const parsed = ReflectBodySchema.safeParse(JSON.parse(await readBody(req, res)));
        if (!parsed.success) {
          sendJson(res, 400, { error: 'Invalid body: reflected must be a boolean' }, req);
          return;
        }
        const evaluation = await tickets.setReflected(ticketReflectMatch[1]!, parsed.data.reflected);
        sendJson(res, evaluation ? 200 : 404, evaluation ? { evaluation } : { error: '티켓을 찾을 수 없습니다' }, req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' }, req);
      }
      return;
    }

    // GET /api/tickets/guide?route=<cwd> — current synthesised RouteGuide (bias)
    // for a route, so the ticket-management view can preview what is injected.
    if (tickets?.guideFor && req.method === 'GET' && url.pathname === '/api/tickets/guide') {
      const route = url.searchParams.get('route');
      if (!route) {
        sendJson(res, 400, { error: 'route query parameter required' }, req);
        return;
      }
      sendJson(res, 200, { guide: tickets.guideFor(route) }, req);
      return;
    }

    const ticketDeleteMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
    if (tickets && req.method === 'DELETE' && ticketDeleteMatch) {
      const ok = await tickets.remove(ticketDeleteMatch[1]!);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '티켓을 찾을 수 없습니다' }, req);
      return;
    }

    // GET /api/evaluations — the evaluation dataset (read-only). Loopback-only:
    // it echoes ticket content (goals/results), matching the /api/tickets guard.
    if (tickets?.listEvaluations && req.method === 'GET' && url.pathname === '/api/evaluations') {
      if (!sensitiveAllowed) {
        sendJson(res, 403, { error: 'Evaluation API is restricted to loopback' }, req);
        return;
      }
      sendJson(res, 200, { evaluations: tickets.listEvaluations() }, req);
      return;
    }

    // ── Mobile connection settings ───────────────────────────────────────────
    // Turns remote access on and mints device tokens: nothing a device token
    // itself may touch.
    if (mobileSettings && url.pathname.startsWith('/api/settings/mobile')) {
      if (!sensitiveAllowed || remoteCaller) {
        sendJson(res, 403, { error: 'Mobile settings are restricted to local callers' }, req);
        return;
      }
      const tokenMatch = url.pathname.match(/^\/api\/settings\/mobile\/tokens\/([^/]+)$/);
      try {
        if (req.method === 'GET' && url.pathname === '/api/settings/mobile') {
          sendJson(res, 200, await mobileSettings.get(), req);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/settings/mobile/restart') {
          const ok = mobileSettings.restart();
          sendJson(res, ok ? 202 : 409, ok ? { restarting: true } : { error: 'Restart from the dashboard needs autostart (launchd). Run: open-alive stop && open-alive start' }, req);
          return;
        }
        if (req.method === 'DELETE' && tokenMatch) {
          mobileSettings.revokeToken(decodeURIComponent(tokenMatch[1]!));
          sendJson(res, 200, await mobileSettings.get(), req);
          return;
        }
        if (req.method === 'POST' && (url.pathname === '/api/settings/mobile' || url.pathname === '/api/settings/mobile/tokens')) {
          let raw: unknown;
          try {
            raw = JSON.parse(await readBody(req, res));
          } catch {
            if (!res.headersSent) sendJson(res, 400, { error: 'Invalid JSON' }, req);
            return;
          }
          if (url.pathname === '/api/settings/mobile/tokens') {
            const parsed = MobileTokenBodySchema.safeParse(raw);
            if (!parsed.success) {
              sendJson(res, 400, { error: 'Invalid body: label (string) is required' }, req);
              return;
            }
            sendJson(res, 201, mobileSettings.createToken(parsed.data.label), req);
            return;
          }
          const parsed = MobileUpdateBodySchema.safeParse(raw);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid body' }, req);
            return;
          }
          sendJson(res, 200, await mobileSettings.update(parsed.data), req);
          return;
        }
      } catch (error) {
        if (error instanceof MobileSettingsError) {
          sendJson(res, 400, { error: error.message }, req);
          return;
        }
        throw error;
      }
    }

    // ── Access settings ──────────────────────────────────────────────────────
    // Decides whether this computer needs a token in remote mode — exactly the
    // kind of switch a remote device must never flip.
    if (accessSettings && url.pathname === '/api/settings/access') {
      if (!sensitiveAllowed || remoteCaller) {
        sendJson(res, 403, { error: 'Access settings are restricted to local callers' }, req);
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, accessSettings.get(), req);
        return;
      }
      if (req.method === 'POST') {
        let raw: unknown;
        try {
          raw = JSON.parse(await readBody(req, res));
        } catch {
          if (!res.headersSent) sendJson(res, 400, { error: 'Invalid JSON' }, req);
          return;
        }
        const parsed = AccessSettingsBodySchema.safeParse(raw);
        if (!parsed.success) {
          sendJson(res, 400, { error: 'Invalid body: requireTokenLocally (boolean) is required' }, req);
          return;
        }
        sendJson(res, 200, accessSettings.setRequireTokenLocally(parsed.data.requireTokenLocally), req);
        return;
      }
    }

    // ── LLM gateway settings ─────────────────────────────────────────────────
    // Writes LITELLM_BASE_URL / LITELLM_KEY to ~/.open-alive/.env, so no
    // scoped remote token may reach it. The key itself is never returned.
    if (gatewaySettings && url.pathname.startsWith('/api/settings/gateway')) {
      if (!sensitiveAllowed || remoteCaller) {
        sendJson(res, 403, { error: 'Gateway settings are restricted to local callers' }, req);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/settings/gateway') {
        sendJson(res, 200, gatewaySettings.get(), req);
        return;
      }
      const isTest = url.pathname === '/api/settings/gateway/test';
      if (req.method === 'POST' && (isTest || url.pathname === '/api/settings/gateway')) {
        let raw: unknown;
        try {
          raw = JSON.parse(await readBody(req, res));
        } catch {
          if (!res.headersSent) sendJson(res, 400, { error: 'Invalid JSON' }, req);
          return;
        }
        try {
          if (isTest) {
            const parsed = GatewayTestBodySchema.safeParse(raw);
            if (!parsed.success) {
              sendJson(res, 400, { error: 'Invalid body: baseUrl (string) is required' }, req);
              return;
            }
            sendJson(res, 200, await gatewaySettings.test(parsed.data), req);
            return;
          }
          const parsed = GatewaySaveBodySchema.safeParse(raw);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'Invalid body: baseUrl (string) is required' }, req);
            return;
          }
          sendJson(res, 200, await gatewaySettings.save(parsed.data), req);
        } catch (error) {
          if (error instanceof GatewaySettingsValidationError) {
            sendJson(res, 400, { error: error.message }, req);
            return;
          }
          console.error('[gateway] settings request failed:', error);
          sendJson(res, 500, { error: 'Failed to apply gateway settings' }, req);
        }
        return;
      }
    }

    // Orchestration backends (loopback-only): list + live connectivity check.
    // Model ids only (no paths, no secrets) — remote devices compose tickets too.
    if (claudeModels && req.method === 'GET' && url.pathname === '/api/claude/models') {
      sendJson(res, 200, claudeModels(), req);
      return;
    }
    // Launch presets for a new terminal tab: the local model Codex can run on
    // (`OA_LOCAL_MODEL`), or null. Model name and provider only.
    if (req.method === 'GET' && url.pathname === '/api/terminal/launch-options') {
      sendJson(res, 200, { localModel: resolveLocalModel(process.env) }, req);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/codex/models') {
      sendJson(res, 200, codexModels ? codexModels.list() : { models: [] }, req);
      return;
    }
    if (backends && req.method === 'GET' && url.pathname === '/api/backends') {
      if (!sensitiveAllowed) {
        sendJson(res, 403, { error: 'Backends API is restricted to loopback' }, req);
        return;
      }
      sendJson(res, 200, { backends: backends.list() }, req);
      return;
    }
    // ── Local git branches ───────────────────────────────────────────────────
    // These check out and delete branches in the user's working tree, so they
    // are loopback-only exactly like the ticket routes. Every branch name is
    // validated in gitBranches before it reaches git.
    if (git && url.pathname.startsWith('/api/git/')) {
      if (!sensitiveAllowed) {
        sendJson(res, 403, { error: 'Git API is restricted to loopback' }, req);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/git/branches') {
        const cwd = url.searchParams.get('cwd');
        if (!cwd || !isAbsolute(cwd)) {
          sendJson(res, 400, { error: 'cwd must be an absolute path' }, req);
          return;
        }
        sendJson(res, 200, { branches: await git.list(cwd) }, req);
        return;
      }
      if (req.method === 'POST' || req.method === 'DELETE') {
        const parsed = GitBranchBodySchema.safeParse(
          JSON.parse(await readBody(req, res).catch(() => '{}') || '{}'),
        );
        if (!parsed.success) {
          sendJson(res, 400, { error: 'Invalid body: cwd and name are required' }, req);
          return;
        }
        const { cwd, name, from } = parsed.data;
        if (url.pathname === '/api/git/checkout' && req.method === 'POST') {
          sendJson(res, 200, { result: await git.switch(cwd, name) }, req);
          return;
        }
        if (url.pathname === '/api/git/branches' && req.method === 'POST') {
          sendJson(res, 200, { result: await git.create(cwd, name, from) }, req);
          return;
        }
        if (url.pathname === '/api/git/branches' && req.method === 'DELETE') {
          sendJson(res, 200, { result: await git.remove(cwd, name) }, req);
          return;
        }
      }
    }

    // POST /api/ssh/browse — list remote sub-directories for the remote folder
    // picker (loopback-only; the ssh target comes from the local user's preset).
    if (sshBrowse && req.method === 'POST' && url.pathname === '/api/ssh/browse') {
      if (!sensitiveAllowed) {
        sendJson(res, 403, { error: 'SSH browse is restricted to loopback' }, req);
        return;
      }
      try {
        const parsed = z
          .object({ ssh: SshTargetSchema, path: z.string().max(4096).optional() })
          .safeParse(JSON.parse(await readBody(req, res)));
        if (!parsed.success) {
          sendJson(res, 400, { error: 'Invalid body: ssh target required' }, req);
          return;
        }
        const result = await sshBrowse(parsed.data.ssh, parsed.data.path);
        sendJson(res, 200, result, req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' }, req);
      }
      return;
    }
    const backendCheckMatch = url.pathname.match(/^\/api\/backends\/([^/]+)\/check$/);
    if (backends && req.method === 'POST' && backendCheckMatch) {
      if (!sensitiveAllowed) {
        sendJson(res, 403, { error: 'Backends API is restricted to loopback' }, req);
        return;
      }
      const status = await backends.check(backendCheckMatch[1]!);
      sendJson(res, status ? 200 : 404, status ? { status } : { error: 'Unknown backend' }, req);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const snapshot = getSnapshot() as { recentEvents?: unknown };
      sendJson(res, 200, snapshot.recentEvents ?? [], req);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/stats') {
      sendJson(res, 200, getStats(), req);
      return;
    }

    // GET /api/completed?limit=500 — durable archive of terminated sessions, newest first.
    if (req.method === 'GET' && url.pathname === '/api/completed') {
      const all = getCompletedArchive();
      const limitParam = parseInt(url.searchParams.get('limit') ?? '', 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 2000) : 500;
      sendJson(res, 200, { sessions: all.slice(0, limit) }, req);
      return;
    }

    // GET /api/usage — ccusage-style LLM usage records from raw transcripts,
    // for the Tools > Data dashboard. Loopback-only: it reads the local user's
    // Claude Code transcripts (prompt/response metadata lives alongside).
    if (getUsageRecords && req.method === 'GET' && url.pathname === '/api/usage') {
      if (!sensitiveAllowed) {
        sendJson(res, 403, { error: 'Usage API is restricted to loopback' }, req);
        return;
      }
      try {
        const records = await getUsageRecords();
        sendJson(res, 200, { records }, req);
      } catch {
        sendJson(res, 500, { error: 'Failed to read usage transcripts' }, req);
      }
      return;
    }

    // GET /api/fs/browse?dir=/path — list directories for folder picker
    if (req.method === 'GET' && url.pathname === '/api/fs/browse') {
      try {
        const rawDir = url.searchParams.get('dir') || '~';
        const dir = rawDir.startsWith('~') ? pathResolve(homedir(), rawDir.slice(1).replace(/^\//, '')) : pathResolve(rawDir);
        const entries = await readdir(dir, { withFileTypes: true });
        const dirs: { name: string; path: string }[] = [];
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            dirs.push({ name: entry.name, path: pathResolve(dir, entry.name) });
          }
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, { path: dir, dirs, isRoot: dir === '/' }, req);
      } catch {
        sendJson(res, 400, { error: 'Cannot read directory' }, req);
      }
      return;
    }

    // GET /api/projects/names — full cwd→name map
    if (req.method === 'GET' && url.pathname === '/api/projects/names') {
      sendJson(res, 200, { names: getProjectNames() }, req);
      return;
    }

    // PUT /api/projects/names — body: { cwd, name: string | null }
    // null name removes the entry. Broadcasts the new map over WS so every client stays in sync.
    if (req.method === 'PUT' && url.pathname === '/api/projects/names') {
      try {
        const body = await readBody(req, res);
        const parsed = ProjectNameBodySchema.safeParse(JSON.parse(body));
        if (!parsed.success) {
          sendJson(res, 400, { error: 'Invalid body' }, req);
          return;
        }
        const { cwd, name } = parsed.data;
        if (name === null) {
          await removeProjectName(cwd);
        } else {
          await saveProjectName(cwd, name);
        }
        onProjectNamesChanged?.();
        sendJson(res, 200, { names: getProjectNames() }, req);
      } catch {
        sendJson(res, 500, { error: 'Failed to save project name' }, req);
      }
      return;
    }

    // GET /api/claude/sessions?cwd=/abs/path — list past Claude sessions for a project
    if (req.method === 'GET' && url.pathname === '/api/claude/sessions') {
      try {
        const cwd = url.searchParams.get('cwd');
        if (!cwd) {
          sendJson(res, 400, { error: 'cwd query parameter required' }, req);
          return;
        }
        const sessions = await listClaudeSessions(cwd);
        sendJson(res, 200, { sessions }, req);
      } catch {
        sendJson(res, 500, { error: 'Failed to list sessions' }, req);
      }
      return;
    }

    // ── Remote app surface ──────────────────────────────────────────────────
    // The narrow, allowlist-shaped replacement for /api/fs/browse: it answers
    // "which directories may a ticket run in", never "what is on this disk".
    if (req.method === 'GET' && url.pathname === '/api/remote/projects') {
      if (!remoteProjects) {
        sendJson(res, 503, { error: 'Remote project listing is not configured' }, req);
        return;
      }
      sendJson(res, 200, { projects: await remoteProjects() }, req);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/remote/capabilities') {
      // The level gates device tokens only. A full-access caller's socket is not
      // marked remote, so it may already send every terminal:* message.
      const terminal = remoteCaller ? accessPolicy.terminalLevel : 'shell';
      sendJson(res, 200, { terminal, remote: accessPolicy.enabled }, req);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/remote/branches') {
      const cwd = url.searchParams.get('cwd') ?? '';
      if (!remoteBranches) {
        sendJson(res, 503, { error: 'Remote branch listing is not configured' }, req);
        return;
      }
      if (!cwd) {
        sendJson(res, 400, { error: 'cwd is required' }, req);
        return;
      }
      try {
        sendJson(res, 200, await remoteBranches(cwd), req);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'branch listing failed' }, req);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true }, req);
      return;
    }

    // Static file serving + SPA fallback
    if (req.method === 'GET') {
      const served = await serveStatic(url.pathname, res);
      if (served) return;
    }

    sendJson(res, 404, { error: 'Not found' }, req);
  });

  return server;
}
