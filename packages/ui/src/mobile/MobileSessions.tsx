import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeAccountsUsage, WSClientMessage, WSServerMessage } from '@open-alive/core';
import type { RawMessageSubscribe } from '../App.tsx';
import { MobileSessionList, type MobileSession } from './MobileSessionList.tsx';
import { MobileTerminal } from './MobileTerminal.tsx';
import { MobileSpawnPicker, type MobileSpawnRequest } from './MobileSpawnPicker.tsx';
import { phoneSpawnMessage } from './phoneSpawn.ts';
import { useLocalModel } from '../hooks/useLaunchOptions.ts';
import { generateFallbackUuid } from '../views/chat/tabId.ts';
import { loadRecentFolders, pushRecentFolder } from '../views/chat/recentFolders.ts';
import { splitSessions } from './sessionStatus.ts';
import { createTermFeed, type TermFeed } from './termFeed.ts';
import { projectName } from '../views/tickets/ticketDisplay.ts';
import type { MobileProject } from './types.ts';
import type { RemoteTerminalLevel } from './capabilities.ts';
import type { LiveSessions } from './sessionStatus.ts';
import { primaryButton, actionBar } from './styles.ts';
import { useTranslation } from 'react-i18next';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

/** How often the session list is refetched. */
const POLL_MS = 4000;
/** Columns for a shell the phone starts: a phone reading 80-column output is a wall of broken lines. */
const PHONE_COLS = 60;

export interface MobileSessionsProps {
  subscribeRaw: RawMessageSubscribe;
  send: (msg: WSClientMessage) => void;
  terminalLevel: RemoteTerminalLevel;
  /** Where a phone-started shell may run; only used at the `shell` level. */
  projects: MobileProject[];
  /** The PC's live sessions, so the phone calls running what the PC sidebar does. */
  live?: LiveSessions;
  /** Claude account rotation (from the usage snapshot); absent = off. */
  claudeAccounts?: ClaudeAccountsUsage;
}

interface TreeSession {
  sessionId: string;
  providerSessionId?: string;
  currentTool?: string;
  title?: string;
  state?: string;
  pendingApprovals?: number;
  lastActiveAt?: number;
}

interface TreeWorkspace {
  workspace?: { rootPath?: string; displayName?: string };
  sessions?: TreeSession[];
}

interface Tree {
  locations?: Array<{ workspaces?: TreeWorkspace[] }>;
}

/** UUID without a secure context: a phone on plain http over the LAN has no `crypto.randomUUID`. */
function uuid(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID?.()) || generateFallbackUuid();
}

/** Flatten locations → workspaces → sessions, carrying the workspace path down. */
export function flattenTree(tree: Tree): MobileSession[] {
  const out: MobileSession[] = [];
  for (const location of tree.locations ?? []) {
    for (const workspace of location.workspaces ?? []) {
      const cwd = workspace.workspace?.rootPath ?? '';
      const name = workspace.workspace?.displayName;
      for (const session of workspace.sessions ?? []) {
        out.push({
          sessionId: session.sessionId,
          providerSessionId: session.providerSessionId ?? session.sessionId,
          displayName: session.title ?? '',
          state: session.state ?? 'unknown',
          cwd,
          lastActivityAt: session.lastActiveAt ?? 0,
          needsApproval: (session.pendingApprovals ?? 0) > 0,
          ...(typeof session.currentTool === 'string' ? { currentTool: session.currentTool } : {}),
          ...(name ? { projectName: name } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * The sessions half of the phone app: what is running on this machine, and its
 * terminal.
 *
 * Tapping a session opens the pty directly. The structured conversation was in
 * between for a while, but it is a second copy of what the terminal already
 * shows and a phone has room for one of them — and only the terminal can be
 * answered.
 */
export function MobileSessions({ subscribeRaw, send, terminalLevel, projects, live = null, claudeAccounts }: MobileSessionsProps) {
  const { t } = useTranslation();
  const localModel = useLocalModel();
  const [sessions, setSessions] = useState<MobileSession[]>([]);
  const [loading, setLoading] = useState(true);
  // Why the last fetch failed; the list keeps its last good rows meanwhile.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<MobileSession | null>(null);
  const [attachedTab, setAttachedTab] = useState<string | null>(null);
  // The shell this phone spawned (and so may resize), with the rows last sent for it.
  const ownedTabRef = useRef<{ tabId: string; rows: number } | null>(null);
  // A fresh feed per opened terminal: the xterm resets when it changes.
  const [feed, setFeed] = useState<TermFeed>(() => createTermFeed());
  const [hasOutput, setHasOutput] = useState(false);
  const clearOutput = useCallback(() => {
    setFeed(createTermFeed());
    setHasOutput(false);
  }, []);
  const [exited, setExited] = useState(false);
  const [picking, setPicking] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // The picker's quick picks, as the PC dialog's: folders running now, then
  // folders used before (this device's launches, then the session history).
  const spawnFolders = useMemo(() => {
    const named = (path: string) => ({
      path,
      name: sessions.find((s) => s.cwd === path)?.projectName || projectName(path),
    });
    const { active } = splitSessions(sessions, live);
    const running = [...new Set(active.map((r) => r.session.cwd))].map(named);
    const history = [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt).map((s) => s.cwd);
    const recent = [...new Set([...loadRecentFolders(), ...history])].slice(0, 12).map(named);
    return { running, recent };
  }, [sessions, live]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v2/workspace-tree`);
      if (!res.ok) {
        // A 503 here means the server's event log is down; an empty list would
        // read as "nothing is running".
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setLoadError(`HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}`);
        return;
      }
      setSessions(flattenTree((await res.json()) as Tree));
      setLoadError(null);
    } catch (err) {
      // Offline; the next tick retries.
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // The catalog is fetched rather than pushed: `v2:catalog-changed` carries no
  // payload, so one poll covers both that signal and a dropped socket.
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  // Terminal frames ride the shared socket; only this tab's are ours.
  useEffect(() => {
    if (!attachedTab) return;
    return subscribeRaw((msg: WSServerMessage) => {
      if (msg.type === 'terminal:output' && msg.tabId === attachedTab) {
        feed.push({ kind: 'data', data: msg.data });
        setHasOutput(true);
      } else if (msg.type === 'terminal:restore' && msg.tabId === attachedTab) {
        // A replay is the whole scrollback: start from a clean screen.
        feed.push({ kind: 'reset' });
        feed.push({ kind: 'data', data: msg.data });
        if (msg.data) setHasOutput(true);
      } else if (msg.type === 'terminal:size' && msg.tabId === attachedTab) {
        feed.push({ kind: 'size', cols: msg.cols, rows: msg.rows });
      } else if (msg.type === 'terminal:exited' && msg.tabId === attachedTab) {
        setExited(true);
      } else if ((msg.type === 'terminal:dormant' || msg.type === 'terminal:missing') && msg.tabId === attachedTab) {
        setExited(true);
      }
    });
  }, [attachedTab, subscribeRaw, feed]);

  /** Open a session straight into its pty; a session Alive never spawned has none. */
  const openSession = useCallback(async (session: MobileSession) => {
    setOpen(session);
    clearOutput();
    setExited(false);
    setAttachedTab(null);
    try {
      const res = await fetch(`${API_BASE}/api/v2/sessions/${encodeURIComponent(session.sessionId)}/terminal`);
      const data = res.ok ? ((await res.json()) as { live?: boolean; tabId?: string }) : null;
      if (data?.live && data.tabId) {
        setAttachedTab(data.tabId);
        send({ type: 'terminal:attach', tabId: data.tabId });
      } else {
        setExited(true);
      }
    } catch {
      setExited(true);
    }
  }, [send, clearOutput]);

  /**
   * Start a terminal from the phone, the way the PC dialog does: Claude with a
   * fresh session id (so the PC links the tab to its session), Codex (cloud or
   * the server's local model), or a plain shell.
   * Sized 60 columns rather than inherited: the pty wraps to the columns it is
   * told about, and a phone reading 80-column output is a wall of broken lines.
   */
  const spawn = useCallback(({ cwd, mode, skipPermissions, claudeAccount }: MobileSpawnRequest) => {
    const tabId = `phone-${uuid()}`;
    ownedTabRef.current = { tabId, rows: 24 };
    setPicking(false);
    clearOutput();
    setExited(false);
    pushRecentFolder(cwd);
    const name = sessionsRef.current.find((s) => s.cwd === cwd)?.projectName || projectName(cwd);
    setOpen({ sessionId: tabId, providerSessionId: '', displayName: name, state: 'running', cwd, lastActivityAt: Date.now(), needsApproval: false });
    setAttachedTab(tabId);
    send(phoneSpawnMessage({ tabId, cwd, mode, skipPermissions, sessionId: uuid(), ...(claudeAccount ? { claudeAccount } : {}) }));
    send({ type: 'terminal:resize', tabId, cols: PHONE_COLS, rows: 24 });
  }, [send, clearOutput]);

  // Fill the pane: a shell the phone started may take the phone's height in rows.
  const fitOwnedRows = useCallback((rows: number) => {
    const owned = ownedTabRef.current;
    if (!owned || owned.tabId !== attachedTab || owned.rows === rows) return;
    ownedTabRef.current = { tabId: owned.tabId, rows };
    send({ type: 'terminal:resize', tabId: owned.tabId, cols: PHONE_COLS, rows });
  }, [attachedTab, send]);

  const close = () => { setOpen(null); setAttachedTab(null); clearOutput(); };

  if (open) {
    return (
      <MobileTerminal
        title={open.displayName || open.sessionId.slice(0, 12)}
        subtitle={projectName(open.cwd)}
        feed={feed}
        hasOutput={hasOutput}
        canType={attachedTab !== null && (terminalLevel === 'input' || terminalLevel === 'shell')}
        exited={exited}
        onBack={close}
        onSend={(data) => attachedTab && send({ type: 'terminal:input', tabId: attachedTab, data })}
        onKey={(sequence) => attachedTab && send({ type: 'terminal:input', tabId: attachedTab, data: sequence })}
        onRefresh={attachedTab ? () => { clearOutput(); send({ type: 'terminal:attach', tabId: attachedTab }); } : undefined}
        onFitRows={ownedTabRef.current?.tabId === attachedTab ? fitOwnedRows : undefined}
      />
    );
  }

  if (picking) {
    return (
      <MobileSpawnPicker
        running={spawnFolders.running}
        recent={spawnFolders.recent}
        projects={projects}
        localModel={localModel?.model ?? null}
        {...(claudeAccounts ? { accounts: { names: claudeAccounts.accounts.map((a) => a.name), active: claudeAccounts.active } } : {})}
        onCancel={() => setPicking(false)}
        onSpawn={spawn}
      />
    );
  }

  return (
    <>
      <MobileSessionList
        sessions={sessions}
        loading={loading}
        error={loadError}
        onOpen={(id) => {
          const session = sessions.find((s) => s.sessionId === id);
          if (session) void openSession(session);
        }}
        onRefresh={reload}
        live={live}
      />
      {terminalLevel === 'shell' && (
        <div style={actionBar}>
          <button style={primaryButton} onClick={() => setPicking(true)}>{t('mobile.terminalNew')}</button>
        </div>
      )}
    </>
  );
}
