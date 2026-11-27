import { TERMINAL_SET_MODE_EVENT } from '../../state/terminalViewSwitch.ts';
import {
  DEFAULT_BOTTOM_HEIGHT,
  DEFAULT_RIGHT_WIDTH,
  TERMINAL_BOTTOM_HEIGHT_KEY,
  TERMINAL_MODE_KEY,
  TERMINAL_RIGHT_WIDTH_KEY,
  browserStorage,
  loadDockSize,
  loadTerminalMode,
  saveTerminalPref,
} from '../../state/terminalDock.ts';
import { useLocalModel } from '../../hooks/useLaunchOptions.ts';
import { FolderColumns } from './FolderColumns.tsx';
import {
  availableLaunchProfiles,
  resolveLaunchProfile,
  loadLaunchProfile,
  saveLaunchProfile,
  type LaunchProfileId,
} from '../../state/launchProfile.ts';
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import type { MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { WSServerMessage, TerminalMode as TerminalSpawnMode, TerminalSource, ClaudeAccountsUsage } from '@open-alive/core';
import { TerminalTabBar } from './TerminalTabBar.tsx';
import type { Tab } from './TerminalTabBar.tsx';
import { SSHPresetDialog } from './SSHPresetDialog.tsx';
import {
  loadPresets,
  createPreset,
  updatePreset as updatePresetStore,
  deletePreset as deletePresetStore,
} from './sshPresets.ts';
import type { SSHPreset, SSHPresetDraft } from './sshPresets.ts';
import { loadRecentFolders, pushRecentFolder, removeRecentFolder } from './recentFolders.ts';
import { loadOpenTabs, saveOpenTabs } from './openTabsStore.ts';
import type { PersistedTab } from './openTabsStore.ts';
import { makeTabId, generateFallbackUuid } from './tabId.ts';
import { useSpreadView } from './useSpreadView.ts';
import { getSettings, resolveTerminalTheme, getFontFamily, subscribeSettings, TERMINAL_MIN_CONTRAST } from '../../services/settings.ts';
import { getAppTheme, subscribeAppTheme, type ResolvedTheme } from '../../services/appearance.ts';
import { loadTerminalFont } from '../../services/terminalFonts.ts';
import type { AppSettings } from '../../services/settings.ts';

export type TerminalEventHandler = (msg: WSServerMessage) => void;

/** Parameters passed to the spawn callback. */
export interface SpawnRequest {
  tabId: string;
  cwd?: string;
  skipPermissions?: boolean;
  mode: TerminalSpawnMode;
  source: TerminalSource;
  initialCommand?: string;
  /** UUID passed via `claude --session-id` to 1:1 pair the tab with a Claude session. */
  claudeSessionId?: string;
  /** Pre-existing Claude session UUID to resume via `claude --resume`. Wins over claudeSessionId. */
  resumeSessionId?: string;
  /** Initial display name passed via `claude -n`. */
  displayName?: string;
  /** Codex only: run on the server's local model (`OA_LOCAL_MODEL`). */
  localModel?: boolean;
  /** Claude only, with account rotation: run on this account (absent = server's choice). */
  claudeAccount?: string;
}

/** Lightweight SSH tab projection broadcast to App so the sidebar can show a presence indicator. */
export interface SshSessionInfo {
  tabId: string;
  label: string;
  presetId?: string;
  /** Mirrors Tab.status. `waiting` only ever applies to Claude tabs, never SSH, but the
   *  type is widened to keep both surfaces in sync without a discriminated union. */
  status: 'idle' | 'active' | 'waiting' | 'done';
  exited: boolean;
  hasError: boolean;
}

/** Idle-timeout after the last output before a tab transitions from active → idle (ms). */
const ACTIVITY_IDLE_MS = 1500;

type TerminalMode = 'popup' | 'bottom' | 'right' | 'fullscreen';

const MIN_BOTTOM_HEIGHT = 150;
const MAX_BOTTOM_RATIO = 0.85; // 85% of viewport height
const MIN_RIGHT_WIDTH = 200;
const MAX_RIGHT_RATIO = 0.75; // 75% of viewport width

interface ChatOverlayProps {
  open: boolean;
  onToggle: () => void;
  onSpawn?: (req: SpawnRequest) => void;
  onInput?: (tabId: string, data: string) => void;
  onResize?: (tabId: string, cols: number, rows: number) => void;
  onClose?: (tabId: string) => void;
  terminalEventRef?: MutableRefObject<TerminalEventHandler | null>;
  projectPaths?: string[];
  /**
   * When true, the overlay animates to a full body-area layout (below header, right of left
   * sidebar). The mode-switcher, resize handles, minimize button, and floating collapsed bar
   * are suppressed. The terminal does not move in the DOM — its fixed-position coordinates
   * change and CSS transitions produce the "sliding" animation.
   */
  listViewActive?: boolean;
  /**
   * True while a view that renders its own full body-area content (e.g. Cost) is active.
   * The fullscreen terminal would cover those views, so when one opens we demote the terminal
   * from 'fullscreen' to the minimized 'popup' mode, then restore the prior mode when the user
   * returns to a view that does not conflict (Animation / List).
   */
  contentViewActive?: boolean;
  /** Pixel width of the visible left sidebar. Used to compute the list-view left inset. */
  listLeftInset?: number;
  /**
   * Left edge of the repo sidebar. Body-wide terminal modes start here so the
   * sidebar stays reachable; collapsing the sidebar drops it back to 0.
   */
  leftInset?: number;
  /** Called whenever the set of SSH tabs changes. Enables App/Sidebar to show a presence indicator. */
  onSshSessionsChange?: (sessions: SshSessionInfo[]) => void;
  /**
   * Called whenever the set of currently-open in-chat Claude session ids changes.
   * The sidebar uses this to mark agents NOT in the set as "external" — i.e. anything
   * the user can't see directly in this chat panel right now (closed tabs, SSH-driven
   * remote agents, agents spawned in a separate terminal).
   */
  onChatClaudeSessionsChange?: (sessionIds: Set<string>) => void;
  /**
   * cwd → project display name map. Single source of truth — terminal tabs render their label
   * by looking up the tab's cwd in this map (fallback to pathBasename(cwd)).
   */
  projectNames?: Record<string, string>;
  /**
   * Set of Claude session IDs currently in the `waiting` agent state — i.e. Claude has asked
   * the user a question / permission prompt and is blocked. Tabs matching one of these IDs
   * render the orange "needs attention" tab background. Computed from the WS agent map by App.
   */
  waitingSessionIds?: Set<string>;
  /**
   * WS connection state. On each false→true transition every live tab is
   * reattached to its server-owned pty (resubscribe + scrollback replay).
   */
  connected?: boolean;
  /** Reattach a tab to its server-owned terminal (sends `terminal:attach`). */
  onAttach?: (tabId: string) => void;
  /**
   * When true, lay every open terminal out in a scaled grid (Spread View). Tiles are CSS
   * `transform: scale` snapshots — `fit()`/resize are never called, so the shared pty size is
   * left untouched and no reflow churn is broadcast to other subscribers (design doc §4.1).
   */
  spreadActive?: boolean;
  /** Spread tile click → promote that tab (App returns to the prior view and focuses it). */
  onSelectSpreadTile?: (tabId: string) => void;
  /** Reports the floating layout mode (popup/bottom/right/fullscreen) whenever it changes. */
  onModeChange?: (mode: TerminalMode) => void;
  /** Reports the docked panel size (px, undefined = default) on mount and after each resize drag. */
  onDockSizeChange?: (size: { bottomHeight?: number; rightWidth?: number }) => void;
  /** Claude account rotation, from the usage snapshot. Absent = rotation off. */
  claudeAccounts?: ClaudeAccountsUsage;
  /** Reopen a Claude tab's session on another account. */
  onSwitchAccount?: (tabId: string, account: string) => void;
}

/**
 * Build xterm options from current AppSettings. Pure function — call this every time
 * you need fresh options (new tab, settings change, etc.). The `allowTransparency`
 * flag stays on so the 'transparent' theme preset can show the parent backdrop.
 */
function buildTermOptions(s: AppSettings, appTheme: ResolvedTheme = getAppTheme()) {
  const t = s.terminal;
  return {
    fontFamily: getFontFamily(t.fontFamilyId),
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    theme: resolveTerminalTheme(t.themeId, t.colorOverrides, appTheme),
    // CLIs pick colours assuming a dark terminal (or a light one); keep every cell readable.
    minimumContrastRatio: TERMINAL_MIN_CONTRAST,
    cursorBlink: t.cursorBlink,
    cursorStyle: t.cursorStyle,
    cursorWidth: t.cursorWidth,
    allowTransparency: true,
    scrollback: t.scrollback,
  };
}

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

const HEADER_HEIGHT = 56;

function getListViewStyle(listLeftInset: number): React.CSSProperties {
  return {
    position: 'fixed',
    zIndex: 30,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--frame-bg)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: 'none',
    borderTop: '1px solid var(--border-color)',
    borderLeft: listLeftInset > 0 ? '1px solid var(--border-color)' : 'none',
    overflow: 'hidden',
    top: HEADER_HEIGHT,
    left: listLeftInset,
    width: `calc(100vw - ${listLeftInset}px)`,
    height: `calc(100vh - ${HEADER_HEIGHT}px)`,
    borderRadius: 0,
    transform: 'none',
  };
}

// Spread View occupies the body area below the header, starting past the repo
// sidebar — covering it would put the tiles on top of the only way to switch runs.
function getSpreadViewStyle(leftInset: number): React.CSSProperties {
  return {
    position: 'fixed',
    zIndex: 30,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--frame-bg-solid)',
    border: 'none',
    borderTop: '1px solid var(--border-color)',
    overflow: 'hidden',
    top: HEADER_HEIGHT,
    left: leftInset,
    width: `calc(100vw - ${leftInset}px)`,
    height: `calc(100vh - ${HEADER_HEIGHT}px)`,
    borderRadius: 0,
    transform: 'none',
  };
}

// Transition applied to the overlay root in every mode. Animates when listViewActive toggles,
// mode changes, or sidebar inset changes — the terminal visibly "slides" between layouts.
// Durations tripled from the initial 420ms for a slower, more deliberate feel.
const OVERLAY_TRANSITION = [
  'top 1260ms cubic-bezier(0.22, 1, 0.36, 1)',
  'left 1260ms cubic-bezier(0.22, 1, 0.36, 1)',
  'right 1260ms cubic-bezier(0.22, 1, 0.36, 1)',
  'bottom 1260ms cubic-bezier(0.22, 1, 0.36, 1)',
  'width 1260ms cubic-bezier(0.22, 1, 0.36, 1)',
  'height 1260ms cubic-bezier(0.22, 1, 0.36, 1)',
  'transform 1260ms cubic-bezier(0.22, 1, 0.36, 1)',
  'border-radius 960ms ease',
  'opacity 720ms ease',
].join(', ');

function getModeStyle(
  mode: TerminalMode,
  bottomHeight?: number,
  rightWidth?: number,
  leftInset = 0,
  /** Popup only: horizontal shift from the bottom-centre position, in px. */
  popupOffsetX = 0,
): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'fixed',
    zIndex: 30,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--frame-bg)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid var(--border-color)',
    overflow: 'hidden',
    transition: 'all 250ms ease',
  };

  switch (mode) {
    case 'popup':
      return {
        ...base,
        bottom: 24,
        left: '50%',
        transform: `translateX(calc(-50% + ${popupOffsetX}px))`,
        width: 'min(640px, 90vw)',
        height: '45vh',
        borderRadius: 16,
      };
    case 'bottom':
      return {
        ...base,
        bottom: 0,
        left: leftInset,
        right: 0,
        height: bottomHeight ?? DEFAULT_BOTTOM_HEIGHT,
        borderRadius: 0,
        borderLeft: 'none',
        borderRight: 'none',
        borderBottom: 'none',
      };
    case 'right':
      return {
        ...base,
        top: HEADER_HEIGHT,
        right: 0,
        bottom: 0,
        width: rightWidth ?? DEFAULT_RIGHT_WIDTH,
        borderRadius: 0,
        borderRight: 'none',
        borderTop: 'none',
        borderBottom: 'none',
      };
    case 'fullscreen':
      return {
        ...base,
        top: HEADER_HEIGHT,
        left: leftInset,
        right: 0,
        bottom: 0,
        borderRadius: 0,
        border: 'none',
        borderTop: '1px solid var(--border-color)',
      };
  }
}

const POPUP_OFFSET_KEY = 'open-alive:terminal-popup-offset-x';

/**
 * Popup window: how far it may slide left/right from the centre and still be
 * fully on screen (the bottom-centre anchor stays, only x moves).
 */
export function clampPopupOffset(offset: number, viewportWidth: number, panelWidth: number): number {
  const max = Math.max(0, (viewportWidth - panelWidth) / 2 - 8);
  return Math.min(max, Math.max(-max, offset));
}

// Per-load counter used ONLY for the fallback display label ("Terminal N").
// The tab *id* is a UUID (see makeTabId) — it must be globally unique.
let tabCounter = 0;

function pathBasename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

// Mode button SVG icons
export function ModeIcon({ mode, size = 14 }: { mode: TerminalMode; size?: number }) {
  const s = size;
  switch (mode) {
    case 'popup':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
          <rect x="3" y="4" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case 'bottom':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1" y="8" width="14" height="7" rx="1" fill="currentColor" opacity="0.4" />
        </svg>
      );
    case 'right':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <rect x="9" y="1" width="6" height="14" rx="1" fill="currentColor" opacity="0.4" />
        </svg>
      );
    case 'fullscreen':
      return (
        <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="14" height="14" rx="2" fill="currentColor" opacity="0.3" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
  }
}


export function ChatOverlay({ open, onToggle, onSpawn, onInput, onResize, onClose, terminalEventRef, projectPaths = [], listViewActive = false, contentViewActive = false, listLeftInset = 0, leftInset = 0, onSshSessionsChange, onChatClaudeSessionsChange, projectNames, waitingSessionIds, connected = false, onAttach, spreadActive = false, onSelectSpreadTile, onModeChange, onDockSizeChange, claudeAccounts, onSwitchAccount }: ChatOverlayProps) {
  const { t } = useTranslation();
  const isListView = listViewActive;

  // Panel position and size survive reloads (see state/terminalDock.ts).
  const [mode, setMode] = useState<TerminalMode>(() => loadTerminalMode(browserStorage()));
  // Mode to restore when the user leaves a content view (e.g. Cost) after we demoted
  // a covering fullscreen terminal. Null when there is nothing to restore.
  const restoreModeRef = useRef<TerminalMode | null>(null);
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  useEffect(() => {
    onModeChangeRef.current?.(mode);
    if (mode !== 'fullscreen') saveTerminalPref(browserStorage(), TERMINAL_MODE_KEY, mode);
  }, [mode]);

  // The panel position is chosen in the header (Terminal › Window); it asks here.
  useEffect(() => {
    const onSetMode = (event: Event) => {
      const next = (event as CustomEvent<TerminalMode>).detail;
      if (next === 'popup' || next === 'bottom' || next === 'right') setMode(next);
    };
    window.addEventListener(TERMINAL_SET_MODE_EVENT, onSetMode);
    return () => window.removeEventListener(TERMINAL_SET_MODE_EVENT, onSetMode);
  }, []);

  // Demote fullscreen → popup when a content view opens (the fullscreen terminal would otherwise
  // cover a content view), and restore the prior mode when returning to Animation/List. Runs only
  // when contentViewActive flips, so the user's mode choices inside a content view are left intact.
  useEffect(() => {
    if (contentViewActive) {
      setMode(prev => {
        if (prev === 'fullscreen') {
          restoreModeRef.current = prev;
          return 'popup';
        }
        return prev;
      });
    } else if (restoreModeRef.current) {
      setMode(restoreModeRef.current);
      restoreModeRef.current = null;
    }
  }, [contentViewActive]);
  const [bottomHeight, setBottomHeight] = useState<number | undefined>(() => {
    const px = loadDockSize(browserStorage(), TERMINAL_BOTTOM_HEIGHT_KEY);
    return px === undefined ? undefined : Math.min(Math.max(px, MIN_BOTTOM_HEIGHT), window.innerHeight * MAX_BOTTOM_RATIO);
  });
  const [rightWidth, setRightWidth] = useState<number | undefined>(() => {
    const px = loadDockSize(browserStorage(), TERMINAL_RIGHT_WIDTH_KEY);
    return px === undefined ? undefined : Math.min(Math.max(px, MIN_RIGHT_WIDTH), window.innerWidth * MAX_RIGHT_RATIO);
  });
  // Latest sizes for the drag-end handler, which outlives the render that created it.
  const dockSizeRef = useRef({ bottomHeight, rightWidth });
  dockSizeRef.current = { bottomHeight, rightWidth };
  const onDockSizeChangeRef = useRef(onDockSizeChange);
  onDockSizeChangeRef.current = onDockSizeChange;
  // Report the restored size once so the view underneath reserves the right room from the start.
  useEffect(() => {
    onDockSizeChangeRef.current?.(dockSizeRef.current);
  }, []);
  const resizingRef = useRef<'bottom' | 'right' | null>(null);
  // Popup mode: the window can be slid left/right along the bottom by its title bar.
  const [popupOffsetX, setPopupOffsetX] = useState(() => {
    try {
      const v = Number(localStorage.getItem(POPUP_OFFSET_KEY));
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  });
  const popupDragRef = useRef<{ startX: number; startOffset: number; width: number } | null>(null);
  const onPopupDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const panel = e.currentTarget.parentElement;
    popupDragRef.current = { startX: e.clientX, startOffset: popupOffsetX, width: panel?.getBoundingClientRect().width ?? 640 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, [popupOffsetX]);
  const onPopupDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = popupDragRef.current;
    if (!d) return;
    setPopupOffsetX(clampPopupOffset(d.startOffset + e.clientX - d.startX, window.innerWidth, d.width));
  }, []);
  const onPopupDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!popupDragRef.current) return;
    popupDragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setPopupOffsetX((x) => {
      try {
        localStorage.setItem(POPUP_OFFSET_KEY, String(Math.round(x)));
      } catch {
        // storage disabled: not remembered
      }
      return x;
    });
  }, []);
  // A narrower window must not leave the popup stranded off screen.
  useEffect(() => {
    const onResize = () => setPopupOffsetX((x) => clampPopupOffset(x, window.innerWidth, Math.min(640, window.innerWidth * 0.9)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Stable refs for callbacks — prevents useEffect re-runs on callback reference changes
  const onSpawnRef = useRef(onSpawn);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onCloseRef = useRef(onClose);
  const onSshSessionsChangeRef = useRef(onSshSessionsChange);
  const onChatClaudeSessionsChangeRef = useRef(onChatClaudeSessionsChange);
  const onAttachRef = useRef(onAttach);
  const connectedRef = useRef(connected);
  const onSelectSpreadTileRef = useRef(onSelectSpreadTile);
  onSpawnRef.current = onSpawn;
  const onSwitchAccountRef = useRef(onSwitchAccount);
  onSwitchAccountRef.current = onSwitchAccount;
  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  onCloseRef.current = onClose;
  onSshSessionsChangeRef.current = onSshSessionsChange;
  onChatClaudeSessionsChangeRef.current = onChatClaudeSessionsChange;
  onAttachRef.current = onAttach;
  connectedRef.current = connected;
  onSelectSpreadTileRef.current = onSelectSpreadTile;

  // Tabs that have been (re)attached to their server pty in the current WS
  // connection epoch. Reset on disconnect so a reconnect reattaches everything.
  const attachedRef = useRef<Set<string>>(new Set());
  // Live mirrors for use inside the stable terminal-event handler closure.
  const tabsRef = useRef<Tab[]>([]);
  // Skip-permissions of the chosen launch preset; also applied when a dormant
  // Claude tab is resumed in place. Default preset: Claude with skip ON.
  const skipPermissionsRef = useRef(true);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  /** Tab id pending a close-confirmation. null = no dialog open. */
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  /**
   * External session pending a resume-confirmation. Resuming re-opens a session
   * that may still be running elsewhere; both processes would then write the same
   * transcript. We gate it behind an explicit warning instead of resuming silently.
   */
  const [pendingResume, setPendingResume] = useState<{ sessionId: string; cwd?: string } | null>(null);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [cwdTab, setCwdTab] = useState<'local' | 'ssh'>('local');
  const [customPath, setCustomPath] = useState('');
  const [launchProfileId, setLaunchProfileId] = useState<LaunchProfileId>(() => loadLaunchProfile(browserStorage()));
  /** Account for the next Claude tab; '' = automatic (the account new runs go to). */
  const [launchAccount, setLaunchAccount] = useState('');
  const accountChoices = useMemo(
    () => (claudeAccounts && claudeAccounts.accounts.length >= 2
      ? claudeAccounts.accounts.map((a) => ({ name: a.name, paused: Boolean(a.limitedUntil && a.limitedUntil > Date.now()) }))
      : []),
    [claudeAccounts],
  );
  const localModel = useLocalModel();
  const activeLaunch = resolveLaunchProfile(launchProfileId, localModel !== null);
  tabsRef.current = tabs;
  skipPermissionsRef.current = activeLaunch.skipPermissions;
  const spreadActiveRef = useRef(spreadActive);
  spreadActiveRef.current = spreadActive;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  // Stable primitive keys so the spread effects re-run only when the tab *set* or a tab's
  // *status* changes — not on every terminal-output-driven `tabs` identity change.
  const spreadTabsKey = tabs.map((t) => t.id).join('|');
  const spreadStatusKey = tabs
    .map((t) => `${t.id}:${t.status}:${t.exited ? 'x' + (t.exitCode ?? '') : ''}`)
    .join('|');
  const [_browsePath, setBrowsePath] = useState('~');
  const [browseDirs, setBrowseDirs] = useState<{ name: string; path: string }[]>([]);
  const [browseCurrentPath, setBrowseCurrentPath] = useState('');
  const [browseLoading, setBrowseLoading] = useState(false);

  // SSH preset state
  const [presets, setPresets] = useState<SSHPreset[]>(() => loadPresets());
  const [sshDialogOpen, setSshDialogOpen] = useState(false);

  // Folders the user has previously selected via the local-folder picker.
  // Persisted in localStorage, surfaced as quick shortcuts at the top of the picker.
  const [recentFolders, setRecentFolders] = useState<string[]>(() => loadRecentFolders());

  // Per-tab xterm instances
  const termsRef = useRef(new Map<string, { term: Terminal; fit: FitAddon }>());
  // Per-tab container divs
  const containersRef = useRef(new Map<string, HTMLDivElement>());
  // Per-tab idle-timer handles (for active → idle transition)
  const idleTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Wrapper that holds all tab containers. ChatOverlay is always mounted at the App level
  // and the terminal moves between layouts via CSS transitions on position/size — the DOM
  // is never relocated, so a simple useRef is sufficient.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Track if we've initialized on first open
  const initializedRef = useRef(false);

  /** Transition a tab to "active" and (re)schedule the idle timer. */
  const markTabActivity = useCallback((tabId: string) => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.id !== tabId || tab.exited) return tab;
        // Don't overwrite the orange "waiting" state with green "active" — Claude is still
        // blocked on a prompt even while emitting incidental output (e.g. spinner frames).
        if (tab.status === 'waiting') return tab;
        // Already active: return the same object so `tabs` keeps its identity. This
        // fires on every terminal-output chunk, so a new array here would cascade a
        // re-render, a localStorage write, and App-level state broadcasts per chunk.
        if (tab.status === 'active') return tab;
        changed = true;
        return { ...tab, status: 'active' as const };
      });
      return changed ? next : prev;
    });
    const existing = idleTimersRef.current.get(tabId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      idleTimersRef.current.delete(tabId);
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId && !tab.exited && tab.status === 'active'
            ? { ...tab, status: 'idle' }
            : tab,
        ),
      );
    }, ACTIVITY_IDLE_MS);
    idleTimersRef.current.set(tabId, timer);
  }, []);

  // Project the WS-derived `waiting` agent set onto tab status. When a tab's claudeSessionId
  // enters the set → mark it `waiting` (orange). When it leaves → if the tab is still in
  // `waiting` (i.e. we set it, not the user via terminal output), drop back to `idle`. This
  // does NOT touch tabs in `active` / `done` so terminal-driven transitions still work.
  useEffect(() => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.exited || !tab.claudeSessionId) return tab;
        const shouldWait = waitingSessionIds?.has(tab.claudeSessionId) ?? false;
        if (shouldWait && tab.status !== 'waiting') {
          changed = true;
          return { ...tab, status: 'waiting' as const };
        }
        if (!shouldWait && tab.status === 'waiting') {
          changed = true;
          return { ...tab, status: 'idle' as const };
        }
        return tab;
      });
      return changed ? next : prev;
    });
  }, [waitingSessionIds]);

  interface CreateTabOptions {
    cwd?: string;
    dangerousSkip?: boolean;
    mode?: TerminalSpawnMode;
    source?: TerminalSource;
    initialCommand?: string;
    sshPresetId?: string;
    label?: string;
    /** If set, pass to `claude --resume <uuid>`. Wins over newly-generated claudeSessionId. */
    resumeSessionId?: string;
    /** Optional display name for `claude -n <name>`. */
    displayName?: string;
    /** Codex only: run on the server's local model. */
    localModel?: boolean;
    /** Claude account to run on; absent = the server's choice. */
    claudeAccount?: string;
  }

  // Allocate an xterm instance for `tabId`, mount it into the wrapper, and wire
  // input. Shared by fresh spawns and restored tabs. Returns false if the
  // wrapper isn't mounted yet (caller should abort the spawn/attach).
  const mountTerminalUI = useCallback((tabId: string): boolean => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return false;
    if (termsRef.current.has(tabId)) return true; // already mounted

    const settings = getSettings();
    const container = document.createElement('div');
    container.style.flex = '1';
    container.style.padding = `${settings.terminal.paddingY}px ${settings.terminal.paddingX}px`;
    container.style.overflow = 'hidden';
    container.style.height = '100%';
    // Paint the padding gutter with the terminal background so a light theme
    // doesn't sit inside a dark frame.
    container.style.background = buildTermOptions(settings).theme.background;
    // Set initial visibility here rather than relying solely on the [activeTabId]
    // display-toggle effect: containers are created lazily in a rAF, so restoring
    // several persisted tabs at once mounts their containers AFTER activeTabId has
    // stopped changing — the toggle effect never re-runs and every terminal would
    // render stacked. Spread View manages its own display, so defer to it there.
    const isActive = tabId === activeTabIdRef.current;
    container.style.display = spreadActiveRef.current || isActive ? 'block' : 'none';
    wrapper.appendChild(container);
    containersRef.current.set(tabId, container);

    const term = new Terminal(buildTermOptions(settings));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termsRef.current.set(tabId, { term, fit });

    requestAnimationFrame(() => {
      fit.fit();
      onResizeRef.current?.(tabId, term.cols, term.rows);
      // Only focus the active tab — otherwise each tab restored in this batch
      // steals focus in turn, leaving focus on whichever mounted last.
      if (isActive && !spreadActiveRef.current) term.focus();
    });

    term.onData((data) => {
      onInputRef.current?.(tabId, data);
    });
    return true;
  }, []);

  // Create a new tab: allocate xterm, mount to container, call onSpawn
  const createTab = useCallback(
    (opts: CreateTabOptions = {}) => {
      const tabId = makeTabId();
      const mode: TerminalSpawnMode = opts.mode ?? 'claude';
      const source: TerminalSource = opts.source ?? 'local';
      // Label priority: explicit opts.label (e.g. SSH preset) → projectNames[cwd] → pathBasename(cwd) → fallback.
      const resolvedProjectName = opts.cwd && projectNames ? projectNames[opts.cwd] : undefined;
      const defaultLabel = opts.cwd
        ? resolvedProjectName ?? pathBasename(opts.cwd)
        : t('terminal.tabLabel', { n: ++tabCounter });
      const label = opts.label ?? defaultLabel;

      // Assign a Claude session UUID for 1:1 matching with the sidebar agent.
      // `--resume` reuses an existing session; otherwise we mint a new v4 UUID to hand via --session-id.
      const claudeSessionId =
        mode === 'claude'
          ? opts.resumeSessionId ?? (crypto.randomUUID?.() ?? generateFallbackUuid())
          : undefined;

      setTabs((prev) => [
        ...prev,
        {
          id: tabId,
          label,
          cwd: opts.cwd,
          exited: false,
          status: 'idle',
          source,
          sshPresetId: opts.sshPresetId,
          claudeSessionId,
          mode,
          displayName: opts.displayName,
        },
      ]);
      setActiveTabId(tabId);

      // Defer xterm creation to next frame so the container div exists
      requestAnimationFrame(() => {
        if (!mountTerminalUI(tabId)) return;
        // A freshly-spawned tab is already subscribed on the server; mark it so
        // the attach-on-connect effect doesn't double-subscribe it this epoch.
        attachedRef.current.add(tabId);
        onSpawnRef.current?.({
          tabId,
          cwd: opts.cwd,
          skipPermissions: opts.dangerousSkip,
          mode,
          source,
          initialCommand: opts.initialCommand,
          claudeSessionId: opts.resumeSessionId ? undefined : claudeSessionId,
          resumeSessionId: opts.resumeSessionId,
          displayName: opts.displayName,
          ...(opts.localModel ? { localModel: true } : {}),
          ...(mode === 'claude' && opts.claudeAccount ? { claudeAccount: opts.claudeAccount } : {}),
        });
      });

      return tabId;
    },
    [t, projectNames, mountTerminalUI],
  );

  // Restore a persisted tab after a page reload: recreate the tab UI WITHOUT
  // spawning a new session. The attach-on-connect effect (or the rAF below, if
  // already connected) sends `terminal:attach` to resubscribe to the live pty;
  // the server replies with `terminal:restore` (scrollback) or `terminal:dormant`.
  const restoreTab = useCallback((p: PersistedTab) => {
    setTabs((prev) =>
      prev.some((t) => t.id === p.tabId)
        ? prev
        : [
            ...prev,
            {
              id: p.tabId,
              label: p.label,
              cwd: p.cwd,
              exited: false,
              status: 'idle' as const,
              source: 'local' as const,
              claudeSessionId: p.claudeSessionId,
              mode: p.mode,
              displayName: p.displayName,
            },
          ],
    );
    requestAnimationFrame(() => {
      if (!mountTerminalUI(p.tabId)) return;
      if (connectedRef.current && !attachedRef.current.has(p.tabId)) {
        attachedRef.current.add(p.tabId);
        onAttachRef.current?.(p.tabId);
      }
    });
  }, [mountTerminalUI]);

  // Restore persisted tabs once, on first mount.
  const didRestoreRef = useRef(false);
  useEffect(() => {
    if (didRestoreRef.current) return;
    didRestoreRef.current = true;
    const persisted = loadOpenTabs();
    if (persisted.length === 0) return;
    for (const p of persisted) restoreTab(p);
    setActiveTabId(persisted[persisted.length - 1]!.tabId);
  }, [restoreTab]);

  // Persist the set of open Claude tabs whenever it changes, so a reload can
  // restore them. SSH/shell tabs and exited tabs are excluded — only resumable
  // Claude sessions are worth restoring.
  useEffect(() => {
    const persisted: PersistedTab[] = tabs
      .filter(
        (tab) =>
          !tab.exited &&
          tab.source === 'local' &&
          (tab.mode ?? 'claude') === 'claude' &&
          !!tab.claudeSessionId,
      )
      .map((tab) => ({
        tabId: tab.id,
        claudeSessionId: tab.claudeSessionId,
        cwd: tab.cwd,
        label: tab.label,
        mode: tab.mode ?? 'claude',
        displayName: tab.displayName,
      }));
    saveOpenTabs(persisted);
  }, [tabs]);

  // On disconnect, clear the attached set so a reconnect reattaches every tab.
  useEffect(() => {
    if (!connected) attachedRef.current = new Set();
  }, [connected]);

  // When (re)connected, reattach every live, mounted tab that hasn't been
  // attached in this connection epoch. Covers both first-load restore and
  // reconnect-after-drop; freshly-spawned tabs are pre-marked in createTab.
  useEffect(() => {
    if (!connected) return;
    for (const tab of tabs) {
      if (tab.exited) continue;
      if (!termsRef.current.has(tab.id)) continue;
      if (attachedRef.current.has(tab.id)) continue;
      attachedRef.current.add(tab.id);
      onAttachRef.current?.(tab.id);
    }
  }, [connected, tabs]);

  // A folder listing can answer after the overlay is gone (a closed page, a
  // finished test); updating state then is at best a no-op and at worst throws.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchBrowse = useCallback(
    (dir: string) => {
      setBrowseLoading(true);
      fetch(`${API_BASE}/api/fs/browse?dir=${encodeURIComponent(dir)}`)
        .then((r) => r.json())
        .then((data: { path: string; dirs: { name: string; path: string }[] }) => {
          if (!mountedRef.current) return;
          setBrowseCurrentPath(data.path);
          setBrowseDirs(data.dirs);
          setBrowsePath(data.path);
        })
        .catch(() => {})
        .finally(() => {
          if (mountedRef.current) setBrowseLoading(false);
        });
    },
    [],
  );

  const openLocalPicker = useCallback(() => {
    setCwdPickerOpen(true);
    setCustomPath('');
    fetchBrowse('~');
  }, [fetchBrowse]);

  // Allow other parts of the app (e.g. ProjectSidebar's "New Chat" button)
  // to trigger the same flow as the in-tab "+" button via CustomEvent.
  useEffect(() => {
    const handler = () => {
      openLocalPicker();
    };
    window.addEventListener('terminal:createTab', handler);
    return () => window.removeEventListener('terminal:createTab', handler);
  }, [openLocalPicker]);

  // (Reload guard removed: server-owned ptys now survive a page reload and open
  // tabs are restored + reattached from localStorage, so a Cmd-R no longer loses
  // the session.)

  // Allow sidebar items (agents / SSH presence) to focus a specific terminal tab.
  // Detail accepts either { tabId } (direct match) or { sessionId } (matched via Tab.claudeSessionId).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { tabId?: string; sessionId?: string }
        | undefined;
      if (!detail) return;
      let target: string | undefined;
      if (detail.tabId && tabs.some(t => t.id === detail.tabId)) {
        target = detail.tabId;
      } else if (detail.sessionId) {
        const matched = tabs.find(t => t.claudeSessionId === detail.sessionId);
        if (matched) target = matched.id;
      }
      if (target) setActiveTabId(target);
    };
    window.addEventListener('terminal:focusTab', handler);
    return () => window.removeEventListener('terminal:focusTab', handler);
  }, [tabs]);

  // External-session resume: opens a NEW tab running `claude --resume <sessionId>` in
  // the agent's cwd. The original (external) Claude process keeps running in its own
  // terminal — both write to the same JSONL transcript, so the user should not actively
  // continue both at once. If a tab already exists for this session, just focus it.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { sessionId?: string; cwd?: string }
        | undefined;
      if (!detail?.sessionId) return;
      const existing = tabs.find(t => t.claudeSessionId === detail.sessionId);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      // Don't resume immediately — a session shown as "external" may still be
      // live in another terminal, and resuming makes both write the same
      // transcript. Gate behind a confirm dialog.
      setPendingResume({ sessionId: detail.sessionId, cwd: detail.cwd });
    };
    window.addEventListener('terminal:resumeExternal', handler);
    return () => window.removeEventListener('terminal:resumeExternal', handler);
  }, [tabs]);

  const confirmResume = useCallback(() => {
    setPendingResume((pending) => {
      if (pending) {
        createTab({
          cwd: pending.cwd,
          dangerousSkip: skipPermissionsRef.current,
          mode: 'claude',
          source: 'local',
          resumeSessionId: pending.sessionId,
        });
      }
      return null;
    });
  }, [createTab]);

  const launchPreset = useCallback(
    (preset: SSHPreset) => {
      setSshDialogOpen(false);
      createTab({
        mode: 'shell',
        source: 'ssh',
        initialCommand: preset.autoRun ? preset.command : undefined,
        sshPresetId: preset.id,
        label: preset.label,
      });
    },
    [createTab],
  );

  const handlePickCwd = useCallback(
    (cwd?: string) => {
      const { agent, skipPermissions: skip, local } = activeLaunch;
      setCwdPickerOpen(false);
      setCustomPath('');
      if (cwd) {
        // Record this folder as recently-used so the picker can surface it next time.
        setRecentFolders(pushRecentFolder(cwd));
      }
      // A chosen account only applies while rotation is on and still lists it.
      const account = agent === 'claude' && accountChoices.some((a) => a.name === launchAccount) ? launchAccount : undefined;
      createTab({
        cwd,
        dangerousSkip: skip,
        mode: agent,
        source: 'local',
        ...(local ? { localModel: true } : {}),
        ...(account ? { claudeAccount: account } : {}),
      });
    },
    [createTab, activeLaunch, accountChoices, launchAccount],
  );

  const handleChooseLaunch = useCallback((id: LaunchProfileId) => {
    setLaunchProfileId(id);
    saveLaunchProfile(browserStorage(), id);
  }, []);

  const handleRemoveRecentFolder = useCallback((cwd: string) => {
    setRecentFolders(removeRecentFolder(cwd));
  }, []);

  const handleSavePreset = useCallback(
    (draft: SSHPresetDraft, editingId: string | null) => {
      if (editingId) {
        updatePresetStore(editingId, draft);
      } else {
        createPreset(draft);
      }
      setPresets(loadPresets());
    },
    [],
  );

  const handleDeletePreset = useCallback((id: string) => {
    deletePresetStore(id);
    setPresets(loadPresets());
  }, []);

  /**
   * Project-name → tab label sync. Whenever projectNames changes, recompute each tab's label.
   * Single source of truth: tab.label = projectNames[tab.cwd] ?? pathBasename(tab.cwd).
   * SSH tabs keep whatever label they were given at spawn (e.g. the SSH preset's own name).
   */
  useEffect(() => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.source === 'ssh' || !tab.cwd) return tab;
        const resolved = (projectNames && projectNames[tab.cwd]) || pathBasename(tab.cwd);
        if (resolved === tab.label) return tab;
        changed = true;
        return { ...tab, label: resolved };
      });
      return changed ? next : prev;
    });
  }, [projectNames]);

  // Close a tab: dispose xterm, remove container, call onClose
  /**
   * Reopen a Claude tab's conversation on another account, in place: the
   * server replaces the tab's `claude` with `claude --resume` under that login.
   */
  const switchTabAccount = useCallback((tabId: string, account: string) => {
    const entry = termsRef.current.get(tabId);
    entry?.term.reset();
    entry?.term.write(`\x1b[2m[${t('terminal.account.switching', { account })}]\x1b[0m\r\n`);
    setTabs((prev) =>
      prev.map((tb) => (tb.id === tabId ? { ...tb, accountLimit: undefined, exited: false, dormant: false, status: 'idle' as const } : tb)),
    );
    onSwitchAccountRef.current?.(tabId, account);
  }, [t]);

  const dismissAccountLimit = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((tb) => (tb.id === tabId ? { ...tb, accountLimit: undefined } : tb)));
  }, []);

  const closeTab = useCallback((tabId: string) => {
    const entry = termsRef.current.get(tabId);
    if (entry) {
      entry.term.dispose();
      termsRef.current.delete(tabId);
    }
    const container = containersRef.current.get(tabId);
    if (container) {
      container.remove();
      containersRef.current.delete(tabId);
    }
    const timer = idleTimersRef.current.get(tabId);
    if (timer) {
      clearTimeout(timer);
      idleTimersRef.current.delete(tabId);
    }
    onCloseRef.current?.(tabId);

    setTabs(prev => {
      const next = prev.filter(tab => tab.id !== tabId);
      if (next.length === 0) return next;
      return next;
    });

    setActiveTabId(prev => {
      if (prev !== tabId) return prev;
      // Pick the neighbour in *visual* tab-bar order (tabsRef), not termsRef
      // insertion order — after a reorder those differ, and jumping to a
      // non-adjacent tab is disorienting. Prefer the tab to the left of the
      // closed one, else the new first tab.
      const order = tabsRef.current.map(t => t.id);
      const idx = order.indexOf(tabId);
      const remaining = order.filter(id => id !== tabId);
      if (remaining.length === 0) return '';
      return order[idx - 1] ?? remaining[0]!;
    });
  }, []);

  /**
   * Tab-bar X button handler. Already-exited tabs close immediately (no live work to lose);
   * live tabs queue a confirmation dialog so the user doesn't kill a running session by accident.
   */
  const requestCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab || tab.exited) {
        closeTab(tabId);
        return;
      }
      setPendingCloseTabId(tabId);
    },
    [tabs, closeTab],
  );

  /** Move a tab from `from` to `to` in the tabs array. Bound to TerminalTabBar's onReorder. */
  const reorderTabs = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length || from === to) {
        return prev;
      }
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // When active tab changes, show/hide containers and fit. Skipped in Spread View — the
  // spread effect owns container display/scale there.
  useEffect(() => {
    if (spreadActive) return;
    for (const [id, container] of containersRef.current) {
      container.style.display = id === activeTabId ? 'block' : 'none';
    }
    const entry = termsRef.current.get(activeTabId);
    if (entry) {
      requestAnimationFrame(() => {
        entry.fit.fit();
        entry.term.focus();
      });
    }
  }, [activeTabId, spreadActive]);

  // Live-apply user settings to all open terminal tabs. xterm v6 lets us mutate most
  // options on the fly via `term.options.*`; container padding is plain CSS. After
  // applying we refit because font/lineHeight changes shift the cell grid.
  useEffect(() => {
    let generation = 0;
    const apply = (s: AppSettings) => {
      const opts = buildTermOptions(s);
      const current = ++generation;
      // Assign the font only once its face has loaded: xterm measures the cell grid
      // on assignment, and measuring the fallback left the new font mis-sized.
      void loadTerminalFont(opts.fontFamily, opts.fontSize).then(() => {
        if (current !== generation) return;
        for (const [, entry] of termsRef.current) entry.term.options.fontFamily = opts.fontFamily;
        const activeEntry = termsRef.current.get(activeTabId);
        if (activeEntry && !spreadActiveRef.current) {
          requestAnimationFrame(() => {
            activeEntry.fit.fit();
            onResizeRef.current?.(activeTabId, activeEntry.term.cols, activeEntry.term.rows);
          });
        }
      });
      for (const [, entry] of termsRef.current) {
        // xterm v6 options are individually assignable; reassigning the whole object
        // is also supported. We assign field-by-field for clarity and to avoid losing
        // any option not surfaced in the settings UI.
        entry.term.options.fontSize = opts.fontSize;
        entry.term.options.lineHeight = opts.lineHeight;
        entry.term.options.letterSpacing = opts.letterSpacing;
        entry.term.options.theme = opts.theme;
        entry.term.options.minimumContrastRatio = opts.minimumContrastRatio;
        entry.term.options.cursorBlink = opts.cursorBlink;
        entry.term.options.cursorStyle = opts.cursorStyle;
        entry.term.options.cursorWidth = opts.cursorWidth;
        entry.term.options.scrollback = opts.scrollback;
      }
      const padding = `${s.terminal.paddingY}px ${s.terminal.paddingX}px`;
      for (const [, container] of containersRef.current) {
        container.style.padding = padding;
        container.style.background = opts.theme.background;
      }
      // Refit the active tab so the cell grid matches the new metrics. Skipped in Spread
      // View — a scaled tile must not trigger a shared-pty resize.
      const active = termsRef.current.get(activeTabId);
      if (active && !spreadActiveRef.current) {
        requestAnimationFrame(() => {
          active.fit.fit();
          onResizeRef.current?.(activeTabId, active.term.cols, active.term.rows);
        });
      }
    };
    const unsubscribeSettings = subscribeSettings(apply);
    // 'auto'/'transparent' palettes follow the app theme, which can flip without a
    // settings write (system mode) — re-apply on every theme change too.
    const unsubscribeTheme = subscribeAppTheme(() => apply(getSettings()));
    return () => {
      unsubscribeSettings();
      unsubscribeTheme();
    };
  }, [activeTabId]);

  // ResizeObserver for the wrapper — fit the active tab continuously.
  // During the 420ms view transition this fires on every paint, so xterm resizes
  // smoothly as the window animates between layouts.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // In Spread View the spread effect owns its own rescale observer; the active-tab
    // auto-fit here would resize the shared pty (I1), so it's disabled while spreadActive.
    if (spreadActive) return;

    const ro = new ResizeObserver(() => {
      const entry = termsRef.current.get(activeTabId);
      if (entry) {
        entry.fit.fit();
        onResizeRef.current?.(activeTabId, entry.term.cols, entry.term.rows);
      }
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [activeTabId, spreadActive]);

  // Final refit after the view transition settles. ResizeObserver may batch/skip
  // the last frame; this guarantees xterm reads final dimensions cleanly.
  // 1300ms ≈ 1260ms transition duration + 40ms buffer.
  useEffect(() => {
    if (spreadActive) return;
    const entry = termsRef.current.get(activeTabId);
    if (!entry) return;
    const timer = setTimeout(() => {
      entry.fit.fit();
      onResizeRef.current?.(activeTabId, entry.term.cols, entry.term.rows);
    }, 1300);
    return () => clearTimeout(timer);
  }, [listViewActive, listLeftInset, leftInset, activeTabId, spreadActive]);

  // Re-fit terminals when mode changes (container size changes).
  // Matches the 1260ms positional transition + 40ms buffer.
  useEffect(() => {
    if (spreadActive) return;
    const entry = termsRef.current.get(activeTabId);
    if (entry) {
      const timer = setTimeout(() => {
        entry.fit.fit();
        onResizeRef.current?.(activeTabId, entry.term.cols, entry.term.rows);
      }, 1300);
      return () => clearTimeout(timer);
    }
  }, [mode, activeTabId, spreadActive]);

  // Initialize first tab when overlay opens — show picker instead of auto-creating
  useEffect(() => {
    if (open && !initializedRef.current) {
      initializedRef.current = true;
      setCwdPickerOpen(true);
      fetchBrowse('~');
    }
  }, [open, fetchBrowse]);

  // Focus active terminal when overlay opens
  useEffect(() => {
    if (open && !cwdPickerOpen) {
      setTimeout(() => {
        termsRef.current.get(activeTabId)?.term.focus();
      }, 100);
    }
  }, [open, activeTabId, cwdPickerOpen]);

  // Broadcast SSH tab projection to parent so the sidebar can show a presence indicator.
  // We can't hook-track remote activity (hooks run locally only) but at least the user
  // sees that an SSH session is open, its label, and whether it's sending output.
  useEffect(() => {
    const sshSessions: SshSessionInfo[] = tabs
      .filter((t) => t.source === 'ssh')
      .map((t) => ({
        tabId: t.id,
        label: t.label,
        presetId: t.sshPresetId,
        status: t.status,
        exited: t.exited,
        hasError: !!t.sshError,
      }));
    onSshSessionsChangeRef.current?.(sshSessions);
  }, [tabs]);

  // Emit the set of currently-open in-chat Claude session ids. Excludes exited tabs
  // (the underlying Claude process is gone) and SSH tabs (no local sessionId — the
  // remote Claude, if any, runs on the other machine and we can't see its hooks).
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of tabs) {
      if (t.source !== 'ssh' && !t.exited && t.claudeSessionId) {
        ids.add(t.claudeSessionId);
      }
    }
    onChatClaudeSessionsChangeRef.current?.(ids);
  }, [tabs]);

  // Register terminal event handler for incoming server messages
  useEffect(() => {
    if (!terminalEventRef) return;
    // Resume a restored tab in place: clear the pane, show a hint, and spawn
    // `claude --resume <sessionId>` under the SAME tabId so the conversation and
    // session reload where the tab already sits. Shared by dormant (server knows
    // the session id) and missing (client supplies its own persisted id).
    const resumeInPlace = (tabId: string, claudeSessionId: string) => {
      const entry = termsRef.current.get(tabId);
      entry?.term.reset();
      entry?.term.write(`\x1b[2m[${t('terminal.resumingSession')}]\x1b[0m\r\n`);
      const tab = tabsRef.current.find((tb) => tb.id === tabId);
      onSpawnRef.current?.({
        tabId,
        cwd: tab?.cwd,
        skipPermissions: skipPermissionsRef.current,
        mode: tab?.mode ?? 'claude',
        source: 'local',
        resumeSessionId: claudeSessionId,
        displayName: tab?.displayName,
      });
      attachedRef.current.add(tabId);
      setTabs((prev) =>
        prev.map((tb) => (tb.id === tabId ? { ...tb, dormant: false, exited: false } : tb)),
      );
    };
    terminalEventRef.current = (msg: WSServerMessage) => {
      if (msg.type === 'terminal:output') {
        termsRef.current.get(msg.tabId)?.term.write(msg.data);
        markTabActivity(msg.tabId);
      } else if (msg.type === 'terminal:restore') {
        // Reattached to a live pty: repaint the screen from the server's
        // scrollback. reset() first so a resubscribe (reconnect) doesn't
        // duplicate content already on-screen.
        const entry = termsRef.current.get(msg.tabId);
        if (entry) {
          entry.term.reset();
          entry.term.write(msg.data);
        }
        // Clear any stale dormant/exited flag now that the session is live again.
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === msg.tabId ? { ...tab, dormant: false } : tab,
          ),
        );
        markTabActivity(msg.tabId);
      } else if (msg.type === 'terminal:account') {
        setTabs((prev) =>
          prev.map((tb) => (tb.id === msg.tabId && tb.claudeAccount !== msg.account ? { ...tb, claudeAccount: msg.account } : tb)),
        );
      } else if (msg.type === 'terminal:account-limit') {
        setTabs((prev) =>
          prev.map((tb) =>
            tb.id === msg.tabId ? { ...tb, accountLimit: { ...(msg.account ? { account: msg.account } : {}), line: msg.line } } : tb,
          ),
        );
      } else if (msg.type === 'terminal:dormant') {
        // The server restarted: no live pty, but it remembers this session id.
        resumeInPlace(msg.tabId, msg.claudeSessionId);
      } else if (msg.type === 'terminal:missing') {
        // The server has no live pty AND no record for this tab. Resume from the
        // tab's OWN persisted claudeSessionId so it isn't left blank. If the tab
        // has no session id (nothing to resume), leave it as-is.
        const tab = tabsRef.current.find((tb) => tb.id === msg.tabId);
        if (tab?.claudeSessionId) resumeInPlace(msg.tabId, tab.claudeSessionId);
      } else if (msg.type === 'terminal:exited') {
        const timer = idleTimersRef.current.get(msg.tabId);
        if (timer) {
          clearTimeout(timer);
          idleTimersRef.current.delete(msg.tabId);
        }
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === msg.tabId
              ? { ...tab, exited: true, exitCode: msg.exitCode, status: 'done' }
              : tab,
          ),
        );
      } else if (msg.type === 'terminal:ssh-error') {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === msg.tabId
              ? { ...tab, sshError: { kind: msg.kind, line: msg.line } }
              : tab,
          ),
        );
      }
    };
    return () => {
      terminalEventRef.current = null;
    };
  }, [terminalEventRef, markTabActivity]);

  // Resize drag handler
  const handleResizeStart = useCallback((edge: 'bottom' | 'right') => {
    resizingRef.current = edge;
    document.body.style.cursor = edge === 'bottom' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e: MouseEvent) => {
      if (resizingRef.current === 'bottom') {
        const h = Math.min(
          Math.max(window.innerHeight - e.clientY, MIN_BOTTOM_HEIGHT),
          window.innerHeight * MAX_BOTTOM_RATIO,
        );
        dockSizeRef.current = { ...dockSizeRef.current, bottomHeight: h };
        setBottomHeight(h);
      } else if (resizingRef.current === 'right') {
        const w = Math.min(
          Math.max(window.innerWidth - e.clientX, MIN_RIGHT_WIDTH),
          window.innerWidth * MAX_RIGHT_RATIO,
        );
        dockSizeRef.current = { ...dockSizeRef.current, rightWidth: w };
        setRightWidth(w);
      }
    };

    const onMouseUp = () => {
      const size = dockSizeRef.current;
      if (resizingRef.current === 'bottom' && size.bottomHeight !== undefined) {
        saveTerminalPref(browserStorage(), TERMINAL_BOTTOM_HEIGHT_KEY, size.bottomHeight);
      } else if (resizingRef.current === 'right' && size.rightWidth !== undefined) {
        saveTerminalPref(browserStorage(), TERMINAL_RIGHT_WIDTH_KEY, size.rightWidth);
      }
      // Reported once per drag, not per mousemove, so the view below reflows once.
      onDockSizeChangeRef.current?.(size);
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Cleanup all terminals on unmount
  useEffect(() => {
    const timers = idleTimersRef.current;
    const terms = termsRef.current;
    const containers = containersRef.current;
    return () => {
      for (const { term } of terms.values()) term.dispose();
      for (const timer of timers.values()) clearTimeout(timer);
      terms.clear();
      containers.clear();
      timers.clear();
      initializedRef.current = false;
    };
  }, []);

  // Re-fit terminal when expanding from collapsed state
  useEffect(() => {
    if (spreadActive) return;
    if (open && activeTabId) {
      const entry = termsRef.current.get(activeTabId);
      if (entry) {
        requestAnimationFrame(() => {
          entry.fit.fit();
          entry.term.focus();
        });
      }
    }
  }, [open, activeTabId, spreadActive]);

  // Spread View: interactive resizable tiling grid of live terminals. All the
  // DOM orchestration, gutters, drag-to-swap, keyboard shortcuts and hover hints
  // live in the hook so this component stays focused on the single-tab surface.
  useSpreadView({
    spreadActive,
    spreadTabsKey,
    spreadStatusKey,
    wrapperRef,
    containersRef,
    termsRef,
    tabsRef,
    activeTabIdRef,
    onResizeRef,
    onSelectSpreadTileRef,
    t,
  });

  const uniquePaths = [...new Set(projectPaths)];
  const hasTabs = tabs.length > 0;

  if (!open && !hasTabs && !isListView && !spreadActive) return null;

  // Compose root style: the mode/list layout geometry plus a shared transition so changes
  // to any positioning property animate. Opacity handles open/close; transform: none in
  // list-view clears the popup's translateX so the terminal "slides" to its new position.
  const layoutStyle = isListView
    ? getListViewStyle(listLeftInset)
    : spreadActive
      ? getSpreadViewStyle(leftInset)
      : getModeStyle(mode, bottomHeight, rightWidth, leftInset, popupOffsetX);
  // In list/spread view with no open tabs, hide the terminal surface so the empty-state
  // rendered in the body shows through. Opening/resuming a tab brings the overlay back.
  const listViewEmpty = isListView && !hasTabs;
  const spreadViewEmpty = spreadActive && !hasTabs;
  const surfaceVisible = open || spreadActive;
  const rootStyle: React.CSSProperties = {
    ...layoutStyle,
    transition: resizingRef.current || popupDragRef.current ? 'none' : OVERLAY_TRANSITION,
    opacity: listViewEmpty || spreadViewEmpty ? 0 : surfaceVisible ? 1 : 0,
    pointerEvents: listViewEmpty || spreadViewEmpty || !surfaceVisible ? 'none' : 'auto',
  };

  const tree = (
    <>
      {/* Collapsed minimized bar — only in floating overlay mode; list view always visible. */}
      {!isListView && !open && hasTabs && (
        <button
          onClick={onToggle}
          style={{
            position: 'fixed',
            bottom: 16,
            right: 16,
            zIndex: 30,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            background: 'var(--frame-bg)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid var(--border-color)',
            borderRadius: 10,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            transition: 'all 0.2s ease',
          }}
        >
          <span style={{ fontSize: 13 }}>▣</span>
          <span>{t('chat.title')}</span>
          <span style={{
            background: 'rgba(88, 166, 255, 0.2)',
            color: 'var(--accent-blue)',
            borderRadius: 8,
            padding: '1px 6px',
            fontSize: 10,
            fontWeight: 600,
          }}>
            {tabs.length}
          </span>
          <span style={{ fontSize: 10, opacity: 0.5 }}>▲</span>
        </button>
      )}

      {/* Always render overlay to preserve xterm DOM — hide with opacity when closed */}
      <div style={rootStyle}>
      {/* Resize handles — floating-mode only */}
      {!isListView && mode === 'bottom' && (
        <div
          onMouseDown={() => handleResizeStart('bottom')}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            cursor: 'row-resize',
            zIndex: 50,
          }}
        />
      )}
      {!isListView && mode === 'right' && (
        <div
          onMouseDown={() => handleResizeStart('right')}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: 6,
            cursor: 'col-resize',
            zIndex: 50,
          }}
        />
      )}
      {/* Header — in popup mode it is also the handle for sliding the window left/right. */}
      <div
        data-testid="terminal-title-bar"
        {...(!isListView && !spreadActive && mode === 'popup'
          ? { onPointerDown: onPopupDragStart, onPointerMove: onPopupDragMove, onPointerUp: onPopupDragEnd, onPointerCancel: onPopupDragEnd, title: t('terminal.dragHint') }
          : {})}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--border-color)',
          flexShrink: 0,
          ...(!isListView && !spreadActive && mode === 'popup' ? { cursor: 'ew-resize', userSelect: 'none', touchAction: 'none' } : {}),
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            letterSpacing: '0.05em',
          }}
        >
          ■ {t('chat.title')}
        </span>

        {!isListView && !spreadActive && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {/* Panel position (floating / bottom / right) and the full layout are
                chosen in the header now; only collapse stays on the panel. */}

            {/* Collapse button (minimize) */}
            <button
              onClick={onToggle}
              title={t('terminal.collapse')}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 12,
                padding: '2px 6px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              ▼
            </button>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <TerminalTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={(tabId) => {
          setActiveTabId(tabId);
          // Broadcast so the sidebar / pixel canvas highlight follows the user's tab choice.
          // Use claudeSessionId when available (Claude tabs) and tabId for SSH tabs.
          const tab = tabs.find(t => t.id === tabId);
          const id = tab?.claudeSessionId ?? tabId;
          window.dispatchEvent(
            new CustomEvent('terminal:focusTab', { detail: { sessionId: id, tabId } }),
          );
        }}
        onAdd={openLocalPicker}
        onClose={requestCloseTab}
        onReorder={reorderTabs}
        accountChoices={accountChoices}
        onSwitchAccount={switchTabAccount}
      />

      {/* Usage-limit notice for the active Claude tab: offer the other accounts. */}
      {(() => {
        const tab = tabs.find((tb) => tb.id === activeTabId);
        if (!tab?.accountLimit || accountChoices.length < 2) return null;
        const current = tab.accountLimit.account ?? tab.claudeAccount;
        const others = accountChoices
          .filter((a) => a.name !== current)
          .sort((a, b) => Number(a.paused) - Number(b.paused));
        return (
          <div
            data-testid="terminal-account-limit"
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
              padding: '6px 12px',
              borderBottom: '1px solid var(--border-color)',
              background: 'var(--surface-2)',
              fontSize: 12,
              color: 'var(--text-primary)',
              flexShrink: 0,
            }}
          >
            <span style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>
              {current ? t('terminal.account.limitBanner', { account: current }) : t('terminal.account.limitBannerNoAccount')}
            </span>
            {others.map((a) => (
              <button
                key={a.name}
                onClick={() => switchTabAccount(tab.id, a.name)}
                style={{
                  padding: '3px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  borderRadius: 8,
                  border: '1px solid var(--accent-blue)',
                  background: a.paused ? 'transparent' : 'var(--accent-blue)',
                  color: a.paused ? 'var(--accent-blue)' : 'var(--on-accent)',
                  cursor: 'pointer',
                }}
              >
                {t('terminal.account.reopenOn', { account: a.name })}
                {a.paused ? ` (${t('terminal.account.menuPaused')})` : ''}
              </button>
            ))}
            <button
              onClick={() => dismissAccountLimit(tab.id)}
              style={{ marginLeft: 'auto', padding: '3px 8px', fontSize: 12, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              {t('terminal.account.dismiss')}
            </button>
          </div>
        );
      })()}

      {/* Close-confirmation modal — gates live tabs so the user can't accidentally
          terminate a running Claude session. Exited tabs bypass this and close immediately. */}
      {pendingCloseTabId && createPortal(
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.55)',
          }}
          onClick={() => setPendingCloseTabId(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPendingCloseTabId(null);
            if (e.key === 'Enter') {
              const id = pendingCloseTabId;
              setPendingCloseTabId(null);
              if (id) closeTab(id);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(420px, 92vw)',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 12,
              padding: '20px 22px 18px',
              boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--text-primary)',
                marginBottom: 8,
              }}
            >
              {t('terminal.closeConfirm.title')}
            </div>
            <div
              style={{
                fontSize: 13,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
                marginBottom: 18,
              }}
            >
              {(() => {
                const tab = tabs.find((tab) => tab.id === pendingCloseTabId);
                return tab ? `${tab.label} — ${t('terminal.closeConfirm.message')}` : t('terminal.closeConfirm.message');
              })()}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setPendingCloseTabId(null)}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 500,
                  background: 'transparent',
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {t('terminal.closeConfirm.cancel')}
              </button>
              <button
                autoFocus
                onClick={() => {
                  const id = pendingCloseTabId;
                  setPendingCloseTabId(null);
                  if (id) closeTab(id);
                }}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 600,
                  background: 'var(--accent-red, #f85149)',
                  border: '1px solid var(--accent-red, #f85149)',
                  borderRadius: 8,
                  color: 'var(--on-accent)',
                  cursor: 'pointer',
                }}
              >
                {t('terminal.closeConfirm.confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Resume-confirmation modal — warns that an external session may still be
          running, so resuming can double-write the same transcript. */}
      {pendingResume && createPortal(
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.55)',
          }}
          onClick={() => setPendingResume(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPendingResume(null);
            if (e.key === 'Enter') confirmResume();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(440px, 92vw)',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 12,
              padding: '20px 22px 18px',
              boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              {t('terminal.resumeConfirm.title')}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 18 }}>
              {t('terminal.resumeConfirm.message')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setPendingResume(null)}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 500,
                  background: 'transparent',
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {t('terminal.resumeConfirm.cancel')}
              </button>
              <button
                autoFocus
                onClick={confirmResume}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 600,
                  background: 'var(--accent-amber, #d29922)',
                  border: '1px solid var(--accent-amber, #d29922)',
                  borderRadius: 8,
                  color: 'var(--on-accent)',
                  cursor: 'pointer',
                }}
              >
                {t('terminal.resumeConfirm.confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* SSH preset management dialog */}
      <SSHPresetDialog
        open={sshDialogOpen}
        presets={presets}
        onClose={() => setSshDialogOpen(false)}
        onSave={handleSavePreset}
        onDelete={handleDeletePreset}
        onLaunch={launchPreset}
      />

      {/* CWD Picker overlay */}
      {cwdPickerOpen && createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.6)',
          }}
          onClick={() => setCwdPickerOpen(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') setCwdPickerOpen(false); }}
        >
          <div
            style={{
              width: cwdTab === 'local' ? 'min(1400px, 96vw)' : 'min(640px, 92vw)',
              height: cwdTab === 'local' ? 'min(96vh, 1000px)' : undefined,
              maxHeight: 'min(96vh, 1000px)',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 12,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Picker header with close button */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '12px 16px',
                borderBottom: '1px solid var(--border-color)',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              <span style={{ flex: 1 }}>{t('terminal.selectWorkingDir')}</span>
              <button
                onClick={() => setCwdPickerOpen(false)}
                title={t('terminal.closeDialog')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: 14,
                  padding: '2px 6px',
                  opacity: 0.7,
                }}
              >
                ✕
              </button>
            </div>

            {/* Tab bar: Local folder / SSH remote — separates the two
                fundamentally different connection modes so they no longer
                share one vertical scroll. */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)' }}>
              {([
                { id: 'local' as const, label: t('terminal.tabLocal') },
                { id: 'ssh' as const, label: t('terminal.tabSsh') },
              ]).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setCwdTab(tab.id)}
                  style={{
                    flex: 1,
                    padding: '10px 8px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: cwdTab === tab.id ? '2px solid var(--accent-blue)' : '2px solid transparent',
                    color: cwdTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'color 0.15s ease, border-color 0.15s ease',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab content (scrollable region) */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
              {cwdTab === 'local' ? (
                <FolderColumns
                  quick={uniquePaths}
                  recent={recentFolders}
                  onRemoveRecent={handleRemoveRecentFolder}
                  onPick={handlePickCwd}
                  browsePath={browseCurrentPath}
                  browseDirs={browseDirs}
                  browseLoading={browseLoading}
                  onBrowse={fetchBrowse}
                  manualPath={{ value: customPath, onChange: setCustomPath, onSubmit: handlePickCwd }}
                />
              ) : (
                /* SSH remote tab: presets + management entry point */
                <div>
                  <div style={{ padding: '8px 16px 4px', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {t('terminal.menu.sshPresets')}
                  </div>
                  {presets.length > 0 ? (
                    <div>
                      {presets.map((preset) => (
                        <button
                          key={preset.id}
                          onClick={() => {
                            setCwdPickerOpen(false);
                            launchPreset(preset);
                          }}
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '7px 16px',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'background 0.15s ease',
                            color: 'var(--text-primary)',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(188, 140, 255, 0.08)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span style={{ fontSize: 12, color: 'var(--accent-purple)' }}>🔗</span>
                          <span style={{ fontSize: 12, fontWeight: 500 }}>{preset.label}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-secondary)', opacity: 0.5 }}>
                      {t('terminal.menu.noSshPresets')}
                    </div>
                  )}
                  <button
                    onClick={() => {
                      setCwdPickerOpen(false);
                      setSshDialogOpen(true);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 16px 10px',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background 0.15s ease',
                      color: 'var(--accent-purple)',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(188, 140, 255, 0.08)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ fontSize: 12 }}>➕</span>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{t('terminal.menu.manageSsh')}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5, color: 'var(--text-secondary)' }}>→</span>
                  </button>
                </div>
              )}
            </div>

            {/* Footer: unified launch bar (Local tab only). Groups "how" (skip
                permissions) + "where" (current path) + the primary start action.
                The SSH tab has no footer — presets launch on click. */}
            {cwdTab === 'local' && (
              <div style={{ borderTop: '1px solid var(--border-color)', background: 'var(--bg-primary)', flexShrink: 0, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  {/* Launch presets: which agent CLI, with or without skipping permissions */}
                  <div role="radiogroup" aria-label={t('terminal.launch.label')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {availableLaunchProfiles(localModel !== null).map((profile) => {
                      const selected = profile.id === activeLaunch.id;
                      const accent = profile.skipPermissions ? 'var(--accent-orange, #d29922)' : 'var(--accent-blue)';
                      return (
                        <button
                          key={profile.id}
                          role="radio"
                          aria-checked={selected}
                          onClick={() => handleChooseLaunch(profile.id)}
                          style={{
                            padding: '6px 12px',
                            fontSize: 12,
                            fontWeight: 600,
                            borderRadius: 8,
                            cursor: 'pointer',
                            border: `1px solid ${selected ? accent : 'var(--border-color)'}`,
                            background: selected ? 'var(--hover)' : 'transparent',
                            color: selected ? accent : 'var(--text-secondary)',
                          }}
                        >
                          {t(`terminal.launch.${profile.id}`, { model: localModel?.model ?? '' })}
                        </button>
                      );
                    })}
                  </div>
                  {activeLaunch.skipPermissions && (
                    <span style={{ fontSize: 11, color: 'var(--accent-orange, #d29922)' }}>
                      {t(activeLaunch.agent === 'codex' ? 'terminal.launch.codexSkipWarning' : 'terminal.skipPermissionsWarning')}
                    </span>
                  )}
                </div>
                {/* Claude account (rotation on only): automatic, or a specific login. */}
                {activeLaunch.agent === 'claude' && accountChoices.length >= 2 && (
                  <div data-testid="launch-account" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginRight: 2 }}>{t('terminal.account.label')}</span>
                    <div role="radiogroup" aria-label={t('terminal.account.label')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {[{ name: '', paused: false }, ...accountChoices].map((a) => {
                        const selected = (accountChoices.some((c) => c.name === launchAccount) ? launchAccount : '') === a.name;
                        return (
                          <button
                            key={a.name || 'auto'}
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setLaunchAccount(a.name)}
                            title={a.name ? undefined : t('terminal.account.autoHint', { account: claudeAccounts?.active ?? '—' })}
                            style={{
                              padding: '4px 10px',
                              fontSize: 12,
                              fontWeight: 600,
                              borderRadius: 8,
                              cursor: 'pointer',
                              border: `1px solid ${selected ? 'var(--accent-blue)' : 'var(--border-color)'}`,
                              background: selected ? 'var(--hover)' : 'transparent',
                              color: selected ? 'var(--accent-blue)' : 'var(--text-secondary)',
                            }}
                          >
                            {a.name ? a.name : `${t('terminal.account.auto')} · ${claudeAccounts?.active ?? '—'}`}
                            {a.paused ? ` (${t('terminal.account.menuPaused')})` : ''}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* Resolved target path */}
                <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
                  <span dir="ltr">{browseCurrentPath}</span>
                </div>
                {/* Primary CTA: start the chosen command in the current folder */}
                <button
                  onClick={() => handlePickCwd(browseCurrentPath)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    background: 'var(--accent-blue)',
                    color: 'var(--on-accent)',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                  }}
                >
                  {t('terminal.startHere')} →
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* Terminal containers wrapper */}
      <div
        ref={wrapperRef}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
        }}
      />
    </div>
    </>
  );

  return tree;
}
