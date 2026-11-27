import type { WebSocket } from 'ws';
import type { TerminalMode, TerminalSource, WSServerMessage } from '@open-alive/core';
import { ClaudeTerminal } from './claudeTerminal.js';

/**
 * Server-owned terminals, decoupled from the WebSocket lifecycle.
 *
 * Historically each pty was keyed by the browser's WebSocket, so a refresh or a
 * dropped connection killed the Claude session. Here the pty is owned by the
 * server and keyed by a stable `tabId`. Browsers *subscribe* to a terminal;
 * disconnecting only removes the subscription, the pty keeps running. A
 * reconnecting browser reattaches and replays the scrollback ring buffer.
 */
const SCROLLBACK_MAX_BYTES = 256 * 1024;
// Exited ptys are retained so a reattaching browser can still replay their final
// scrollback and be offered a resume. Cap how many we keep in memory so a
// long-running daemon can't accumulate dead terminals without bound; the oldest
// exited entries are evicted first.
const MAX_EXITED_RETAINED = 50;

export interface ManagedTerminalMeta {
  tabId: string;
  claudeSessionId?: string;
  cwd?: string;
  displayName?: string;
  mode: TerminalMode;
  source: TerminalSource;
  claudeVariant: 'claude' | 'agents';
  /** Claude account rotation: the account this tab's `claude` runs on. */
  claudeAccount?: string;
  /** Whether the tab was opened with permission prompts skipped (kept on an account switch). */
  skipPermissions?: boolean;
}

/**
 * Claude Code's own usage-limit notice (`You've hit your limit · resets 3pm`).
 * Requires the reset clause so a conversation that merely mentions limits does
 * not trigger it; even a match only offers a switch, it never switches.
 */
const ACCOUNT_LIMIT_RE = /(?:you['’]ve hit your (?:session |weekly |opus |sonnet )?limit|usage limit reached)[^\n]{0,60}?resets?\b[^\n]{0,40}/i;
/** One notice per tab per this long, however often the TUI repaints it. */
const ACCOUNT_LIMIT_QUIET_MS = 10 * 60_000;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export interface CreateTerminalOptions {
  tabId: string;
  cwd?: string;
  mode?: TerminalMode;
  source?: TerminalSource;
  claudeVariant?: 'claude' | 'agents';
  skipPermissions?: boolean;
  initialCommand?: string;
  claudeSessionId?: string;
  resumeSessionId?: string;
  displayName?: string;
  localModel?: boolean;
  /** Claude only: extra env for the `claude` process (CLAUDE_CONFIG_DIR of an account). */
  extraEnv?: Record<string, string>;
  /** Claude account rotation: the account name `extraEnv` selects. */
  claudeAccount?: string;
}

interface ManagedTerminal {
  term: ClaudeTerminal;
  scrollback: string;
  subscribers: Set<WebSocket>;
  meta: ManagedTerminalMeta;
  exited: boolean;
  /** Wall-clock ms when the pty exited (or spawn failed). Undefined while live. */
  exitedAt?: number;
  /** Last known pty size — used to force a redraw on reattach. */
  cols: number;
  rows: number;
  /** Tail of recent output (ANSI stripped) scanned for the usage-limit notice. */
  limitTail: string;
  /** Wall-clock ms of the last usage-limit notice sent for this tab. */
  limitNoticeAt?: number;
}

export interface TerminalManagerOptions {
  /** Sends a server message to a single client. */
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  /** Terminal factory — overridable in tests with a fake. */
  createTerminal?: () => ClaudeTerminal;
  /**
   * Called after a terminal transitions to exited (natural exit or spawn
   * failure) so the caller can rebroadcast the resumable set. Errors thrown by
   * the callback are caught and logged so they never break terminal handling.
   */
  onTerminalExit?: (tabId: string) => void;
}

export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private send: TerminalManagerOptions['send'];
  private createTerminal: () => ClaudeTerminal;
  private onTerminalExit?: TerminalManagerOptions['onTerminalExit'];

  constructor(options: TerminalManagerOptions) {
    this.send = options.send;
    this.createTerminal = options.createTerminal ?? (() => new ClaudeTerminal());
    this.onTerminalExit = options.onTerminalExit;
  }

  /** Mark a terminal exited and notify the caller, swallowing callback errors. */
  private markExited(managed: ManagedTerminal): void {
    managed.exited = true;
    managed.exitedAt = Date.now();
    try {
      this.onTerminalExit?.(managed.meta.tabId);
    } catch (err) {
      console.error(`[terminal] onTerminalExit handler failed for ${managed.meta.tabId}:`, err);
    }
  }

  has(tabId: string): boolean {
    return this.terminals.has(tabId);
  }

  /** True when a pty for this tab exists and has not exited. */
  isLive(tabId: string): boolean {
    const managed = this.terminals.get(tabId);
    return managed !== undefined && !managed.exited;
  }

  meta(tabId: string): ManagedTerminalMeta | undefined {
    return this.terminals.get(tabId)?.meta;
  }

  /**
   * Spawn a new terminal and subscribe `ws` to it. If a terminal with this
   * tabId already exists, treat the call as an attach (idempotent spawn).
   */
  create(ws: WebSocket, opts: CreateTerminalOptions): void {
    const existing = this.terminals.get(opts.tabId);
    if (existing) {
      this.subscribe(existing, ws);
      return;
    }
    this.spawnManaged(new Set([ws]), opts);
  }

  /**
   * Replace a tab's process in place (same tabId), keeping every viewer
   * subscribed: used to reopen a Claude session on another account. The old
   * pty is destroyed without an exit notice, so the tab never flashes "exited".
   */
  replace(ws: WebSocket, opts: CreateTerminalOptions): void {
    const old = this.terminals.get(opts.tabId);
    const subscribers = new Set<WebSocket>(old?.subscribers ?? []);
    subscribers.add(ws);
    if (old) {
      old.exited = true; // silences its exit callback
      old.term.destroy();
      this.terminals.delete(opts.tabId);
    }
    this.spawnManaged(subscribers, opts);
  }

  private spawnManaged(subscribers: Set<WebSocket>, opts: CreateTerminalOptions): void {
    const ws = [...subscribers][0]!;

    const isSsh = opts.source === 'ssh';
    const managed: ManagedTerminal = {
      term: this.createTerminal(),
      scrollback: '',
      subscribers,
      exited: false,
      cols: 80,
      rows: 24,
      limitTail: '',
      meta: {
        tabId: opts.tabId,
        claudeSessionId: opts.resumeSessionId ?? opts.claudeSessionId,
        cwd: opts.cwd,
        displayName: opts.displayName,
        mode: opts.mode ?? 'claude',
        source: opts.source ?? 'local',
        claudeVariant: opts.claudeVariant ?? 'claude',
        ...(opts.claudeAccount ? { claudeAccount: opts.claudeAccount } : {}),
        ...(opts.skipPermissions ? { skipPermissions: true } : {}),
      },
    };
    this.terminals.set(opts.tabId, managed);
    const watchLimit = (opts.mode ?? 'claude') === 'claude' && !isSsh;
    if (managed.meta.claudeAccount) {
      this.fanout(managed, { type: 'terminal:account', tabId: opts.tabId, account: managed.meta.claudeAccount });
    }

    try {
      managed.term.spawn({
        handler: (data) => {
          this.appendScrollback(managed, data);
          this.fanout(managed, { type: 'terminal:output', tabId: opts.tabId, data });
          if (watchLimit) this.scanForLimit(managed, data);
        },
        cols: 80,
        rows: 24,
        onExit: (exitCode) => {
          if (this.terminals.get(opts.tabId) !== managed) return; // replaced
          this.markExited(managed);
          this.fanout(managed, { type: 'terminal:exited', tabId: opts.tabId, exitCode });
        },
        onSshError: isSsh
          ? (err) => {
              this.fanout(managed, {
                type: 'terminal:ssh-error',
                tabId: opts.tabId,
                kind: err.kind,
                line: err.line,
              });
            }
          : undefined,
        cwd: opts.cwd,
        mode: opts.mode ?? 'claude',
        claudeVariant: opts.claudeVariant ?? 'claude',
        skipPermissions: opts.skipPermissions,
        initialCommand: opts.initialCommand,
        detectSshErrors: isSsh,
        claudeSessionId: opts.claudeSessionId,
        resumeSessionId: opts.resumeSessionId,
        displayName: opts.displayName,
        localModel: opts.localModel,
        ...(opts.extraEnv ? { extraEnv: opts.extraEnv } : {}),
      });
    } catch (err) {
      // pty.spawn can throw synchronously (e.g. cwd no longer exists for a
      // resumed session, or the shell binary is missing). Without this guard the
      // half-constructed entry would linger with exited=false and no process,
      // making isLive() report true forever and permanently wedging the tab.
      console.error(`[terminal] spawn failed for tab ${opts.tabId}:`, err);
      this.terminals.delete(opts.tabId);
      this.send(ws, { type: 'terminal:exited', tabId: opts.tabId, exitCode: 1 });
      try {
        this.onTerminalExit?.(opts.tabId);
      } catch (cbErr) {
        console.error(`[terminal] onTerminalExit handler failed for ${opts.tabId}:`, cbErr);
      }
      return;
    }

    this.pruneExited();
  }

  /**
   * Evict the oldest exited terminals once retention exceeds MAX_EXITED_RETAINED.
   * Live terminals are never touched. Bounds in-memory growth on a daemon that
   * survives terminal close and accumulates dead ptys over its uptime.
   */
  private pruneExited(): void {
    const exited: Array<[string, ManagedTerminal]> = [];
    for (const [id, m] of this.terminals) {
      if (m.exited) exited.push([id, m]);
    }
    if (exited.length <= MAX_EXITED_RETAINED) return;
    exited.sort((a, b) => (a[1].exitedAt ?? 0) - (b[1].exitedAt ?? 0));
    for (const [id] of exited.slice(0, exited.length - MAX_EXITED_RETAINED)) {
      this.terminals.delete(id);
    }
  }

  /**
   * Reattach a browser to a live terminal. Returns 'restored' (subscribed and
   * scrollback replayed) or 'missing' (no such live terminal — likely dormant).
   */
  attach(tabId: string, ws: WebSocket): 'restored' | 'missing' {
    const managed = this.terminals.get(tabId);
    if (!managed) return 'missing';
    this.subscribe(managed, ws);
    return 'restored';
  }

  input(tabId: string, data: string): void {
    this.terminals.get(tabId)?.term.write(data);
  }

  resize(tabId: string, cols: number, rows: number): void {
    const managed = this.terminals.get(tabId);
    if (!managed) return;
    managed.cols = cols;
    managed.rows = rows;
    managed.term.resize(cols, rows);
    // Every viewer renders at the pty's grid, not its own: a phone watching a
    // desktop-sized Claude session must lay out 120 columns, not reflow them.
    this.fanout(managed, { type: 'terminal:size', tabId, cols, rows });
  }

  /** Explicit user close: destroy the pty and forget the terminal entirely. */
  close(tabId: string): void {
    const managed = this.terminals.get(tabId);
    if (!managed) return;
    managed.term.destroy();
    this.terminals.delete(tabId);
  }

  /** A client disconnected — drop it from every subscription. Ptys keep running. */
  detachClient(ws: WebSocket): void {
    for (const managed of this.terminals.values()) {
      managed.subscribers.delete(ws);
    }
  }

  private subscribe(managed: ManagedTerminal, ws: WebSocket): void {
    managed.subscribers.add(ws);
    // Size first, so the replay below is laid out on the grid it was drawn for.
    this.send(ws, { type: 'terminal:size', tabId: managed.meta.tabId, cols: managed.cols, rows: managed.rows });
    this.send(ws, { type: 'terminal:restore', tabId: managed.meta.tabId, data: managed.scrollback });
    if (managed.meta.claudeAccount) {
      this.send(ws, { type: 'terminal:account', tabId: managed.meta.tabId, account: managed.meta.claudeAccount });
    }
    if (managed.exited) {
      this.send(ws, { type: 'terminal:exited', tabId: managed.meta.tabId, exitCode: 0 });
      return;
    }
    // Replaying raw scrollback does NOT reconstruct a full-screen TUI (e.g. Claude
    // uses the alternate screen + absolute cursor positioning), so a reattaching
    // browser would see a blank screen. Force the app to repaint by toggling the
    // pty size, which fires SIGWINCH. The reattached client is already a
    // subscriber, so the repaint output streams to it.
    this.forceRedraw(managed);
  }

  /**
   * Trigger a SIGWINCH-driven repaint so a reattaching client sees the current
   * frame of a full-screen TUI (Claude). Two synchronous resizes net to no size
   * change and the pty coalesces them into no SIGWINCH, so we bump the size now
   * and restore it on a later tick — two DISTINCT size changes, each delivering a
   * SIGWINCH the TUI actually reacts to. The restore targets the current tracked
   * size in case the client sent its own resize in the interim.
   */
  private forceRedraw(managed: ManagedTerminal): void {
    managed.term.resize(managed.cols, managed.rows + 1);
    setTimeout(() => {
      if (managed.exited) return;
      if (this.terminals.get(managed.meta.tabId) !== managed) return;
      managed.term.resize(managed.cols, managed.rows);
    }, 60);
  }

  /**
   * Watch a Claude tab for Claude Code's usage-limit notice and tell its viewers
   * once (per quiet period), so the UI can offer another account.
   */
  private scanForLimit(managed: ManagedTerminal, data: string): void {
    managed.limitTail = (managed.limitTail + data.replace(ANSI_RE, '')).slice(-2_000);
    const now = Date.now();
    if (managed.limitNoticeAt !== undefined && now - managed.limitNoticeAt < ACCOUNT_LIMIT_QUIET_MS) return;
    const match = ACCOUNT_LIMIT_RE.exec(managed.limitTail);
    if (!match) return;
    managed.limitNoticeAt = now;
    managed.limitTail = '';
    this.fanout(managed, {
      type: 'terminal:account-limit',
      tabId: managed.meta.tabId,
      ...(managed.meta.claudeAccount ? { account: managed.meta.claudeAccount } : {}),
      line: match[0].replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }

  private appendScrollback(managed: ManagedTerminal, data: string): void {
    managed.scrollback += data;
    if (managed.scrollback.length > SCROLLBACK_MAX_BYTES) {
      managed.scrollback = managed.scrollback.slice(-SCROLLBACK_MAX_BYTES);
    }
  }

  private fanout(managed: ManagedTerminal, msg: WSServerMessage): void {
    for (const ws of managed.subscribers) {
      this.send(ws, msg);
    }
  }
}
