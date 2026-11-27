import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SSHErrorKind, TerminalSource, TerminalMode } from '@open-alive/core';

export type TabStatus = 'idle' | 'active' | 'waiting' | 'done';

export interface Tab {
  id: string;
  /** Display label. Computed from projectName (if any) or pathBasename(cwd). */
  label: string;
  /** cwd this tab targets; used to look up the project name and keep labels reactive. */
  cwd?: string;
  exited: boolean;
  exitCode?: number;
  status: TabStatus;
  source: TerminalSource;
  sshPresetId?: string;
  sshError?: { kind: SSHErrorKind; line: string };
  /** Claude CLI session UUID (from --session-id / --resume). */
  claudeSessionId?: string;
  /** Terminal mode — needed to persist & resume the tab across reloads. */
  mode?: TerminalMode;
  /** Display name passed via `claude -n` — persisted for resume. */
  displayName?: string;
  /** True when the server has no live pty for this tab (post-restart); awaiting resume. */
  dormant?: boolean;
  /** Claude account rotation: the account this tab runs on (from the server). */
  claudeAccount?: string;
  /** Set when the tab printed Claude's usage-limit notice; cleared on switch or dismiss. */
  accountLimit?: { account?: string; line: string };
}

/** An account a Claude tab can be reopened on. */
export interface TabAccountChoice {
  name: string;
  /** At the switch threshold or refused a run; still selectable. */
  paused: boolean;
}

interface TerminalTabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onAdd: () => void;
  onClose: (tabId: string) => void;
  /** Reorder callback: move the tab at `fromIndex` so it sits at `toIndex` after the move. */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Claude accounts (rotation on). Fewer than two = no badge and no menu. */
  accountChoices?: TabAccountChoice[];
  /** Reopen a Claude tab on another account (right-click menu). */
  onSwitchAccount?: (tabId: string, account: string) => void;
}

function statusBackground(tab: Tab, isActive: boolean): string {
  if (tab.exited) {
    return isActive ? 'rgba(110, 118, 129, 0.18)' : 'transparent';
  }
  if (tab.status === 'waiting') {
    // Orange sweep — Claude is blocked on a user prompt/permission.
    return 'linear-gradient(90deg, rgba(255,159,67,0.08) 0%, rgba(255,159,67,0.55) 50%, rgba(255,159,67,0.08) 100%)';
  }
  if (tab.status === 'active') {
    return 'linear-gradient(90deg, rgba(46,160,67,0.05) 0%, rgba(46,160,67,0.32) 50%, rgba(46,160,67,0.05) 100%)';
  }
  return isActive ? 'rgba(88, 166, 255, 0.14)' : 'transparent';
}

function statusIcon(tab: Tab): string | null {
  if (!tab.exited) return null;
  if (tab.exitCode === 0) return '✓';
  return '✗';
}

function statusIconColor(tab: Tab): string {
  if (!tab.exited) return 'var(--text-secondary)';
  return tab.exitCode === 0 ? 'var(--accent-green, #3fb950)' : 'var(--accent-red, #f85149)';
}

function borderForSource(tab: Tab): string {
  if (tab.source === 'ssh') {
    const color = tab.sshError ? 'var(--accent-red, #f85149)' : 'var(--accent-purple, #bc8cff)';
    return `2px solid ${color}`;
  }
  return '2px solid transparent';
}

export function TerminalTabBar({
  tabs,
  activeTabId,
  onSelect,
  onAdd,
  onClose,
  onReorder,
  accountChoices = [],
  onSwitchAccount,
}: TerminalTabBarProps) {
  const { t } = useTranslation();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const accountsOn = accountChoices.length >= 2;
  /** Only Claude tabs with a session can move between accounts. */
  const canSwitch = (tab: Tab) =>
    accountsOn && !!onSwitchAccount && tab.source !== 'ssh' && (tab.mode ?? 'claude') === 'claude' && !!tab.claudeSessionId;

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  const menuTab = menu ? tabs.find((tb) => tb.id === menu.tabId) : undefined;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 8px',
        borderBottom: '1px solid var(--border-color)',
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        const icon = statusIcon(tab);
        // Persistent textual status next to the tab name. Only the `waiting`
        // state is surfaced as text — it's the sticky, user-blocking state
        // ("Claude needs your decision") that must be unmistakable. `active`
        // toggles too rapidly (per terminal output) to read as text, so it
        // stays a colour sweep only.
        const waitingLabel = !tab.exited && tab.status === 'waiting' ? t('terminal.status.waiting') : null;
        const sshBorder = tab.source === 'ssh';
        const isDragging = dragIndex === index;
        const isDragTarget = overIndex === index && dragIndex !== null && dragIndex !== index;

        return (
          <div
            key={tab.id}
            draggable={!!onReorder}
            onDragStart={(e) => {
              if (!onReorder) return;
              setDragIndex(index);
              e.dataTransfer.effectAllowed = 'move';
              // Some browsers require non-empty data to initiate the drag.
              try { e.dataTransfer.setData('text/plain', String(index)); } catch { /* ignore */ }
            }}
            onDragOver={(e) => {
              if (!onReorder || dragIndex === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (overIndex !== index) setOverIndex(index);
            }}
            onDragLeave={() => {
              if (overIndex === index) setOverIndex(null);
            }}
            onDrop={(e) => {
              if (!onReorder || dragIndex === null) return;
              e.preventDefault();
              if (dragIndex !== index) onReorder(dragIndex, index);
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            onClick={() => onSelect(tab.id)}
            onContextMenu={(e) => {
              if (!canSwitch(tab)) return;
              e.preventDefault();
              setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
            }}
            title={
              tab.sshError
                ? t(`terminal.sshError.${tab.sshError.kind}`, { defaultValue: tab.sshError.line })
                : tab.label
            }
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              background: statusBackground(tab, isActive),
              backgroundSize:
                tab.status === 'active' || tab.status === 'waiting' ? '200% 100%' : undefined,
              animation:
                tab.status === 'waiting'
                  ? 'claude-tab-sweep 1.2s linear infinite'
                  : tab.status === 'active'
                    ? 'claude-tab-sweep 1.8s linear infinite'
                    : undefined,
              borderLeft: sshBorder ? borderForSource(tab) : 'none',
              border: sshBorder ? undefined : 'none',
              borderRadius: 6,
              boxShadow: isDragTarget
                ? 'inset 2px 0 0 0 var(--accent-blue)'
                : tab.status === 'waiting'
                  ? 'inset 0 0 0 1px rgba(255, 159, 67, 0.7)'
                  : isActive
                    ? 'inset 0 0 0 1px rgba(88, 166, 255, 0.35)'
                    : undefined,
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              cursor: onReorder ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
              opacity: isDragging ? 0.5 : 1,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              whiteSpace: 'nowrap',
              transition: 'background-color 0.15s ease, opacity 0.15s ease',
            }}
          >
            {sshBorder && (
              <span
                aria-hidden
                style={{
                  fontSize: 9,
                  opacity: 0.7,
                  color: tab.sshError
                    ? 'var(--accent-red, #f85149)'
                    : 'var(--accent-purple, #bc8cff)',
                }}
              >
                {tab.sshError ? '⚠' : '⇄'}
              </span>
            )}
            <span style={{ opacity: tab.exited ? 0.65 : 1, display: 'flex', alignItems: 'center', gap: 4 }}>
              {tab.label}
              {accountsOn && tab.claudeAccount && (tab.mode ?? 'claude') === 'claude' && tab.source !== 'ssh' && (
                <span
                  data-testid={`tab-account-${tab.id}`}
                  title={t('terminal.account.badgeTitle', { account: tab.claudeAccount })}
                  style={{
                    fontSize: 9,
                    lineHeight: 1,
                    padding: '2px 4px',
                    borderRadius: 4,
                    border: `1px solid ${tab.accountLimit ? 'var(--accent-amber, #ff9f43)' : 'var(--border-color)'}`,
                    color: tab.accountLimit ? 'var(--accent-amber, #ff9f43)' : 'var(--text-secondary)',
                  }}
                >
                  {tab.claudeAccount}
                </span>
              )}
              {waitingLabel && (
                <span
                  style={{
                    color: 'var(--accent-amber, #ff9f43)',
                    fontWeight: 600,
                    fontSize: 10,
                    lineHeight: 1,
                  }}
                >
                  ({waitingLabel})
                </span>
              )}
              {icon && (
                <span style={{ color: statusIconColor(tab), fontSize: 10, lineHeight: 1 }}>
                  {icon}
                </span>
              )}
              {tab.exited && (
                <span style={{ opacity: 0.55 }}>
                  ({t('terminal.exited')}
                  {typeof tab.exitCode === 'number' ? ` · ${tab.exitCode}` : ''})
                </span>
              )}
            </span>
            {/* Every tab, including the last one, can be closed; with none left
                the overlay falls back to its empty state. */}
            <span
              role="button"
              aria-label={t('terminal.closeTab')}
              title={t('terminal.closeTab')}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              style={{
                fontSize: 10,
                lineHeight: 1,
                padding: '1px 3px',
                borderRadius: 3,
                opacity: 0.5,
                cursor: 'pointer',
              }}
            >
              ✕
            </span>
          </div>
        );
      })}
      {menu && menuTab && (
        <div
          role="menu"
          data-testid="tab-account-menu"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: 10000,
            minWidth: 180,
            padding: 4,
            borderRadius: 10,
            background: 'var(--bg-secondary, var(--surface-2))',
            border: '1px solid var(--border-color)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            fontSize: 12,
          }}
        >
          <div style={{ padding: '6px 10px', color: 'var(--text-secondary)', fontSize: 11 }}>{t('terminal.account.menuTitle')}</div>
          {accountChoices.map((a) => {
            const current = a.name === menuTab.claudeAccount;
            return (
              <button
                key={a.name}
                role="menuitem"
                disabled={current}
                onClick={() => {
                  setMenu(null);
                  onSwitchAccount?.(menuTab.id, a.name);
                }}
                style={{
                  display: 'flex',
                  width: '100%',
                  gap: 8,
                  padding: '6px 10px',
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: current ? 'var(--text-secondary)' : 'var(--text-primary)',
                  cursor: current ? 'default' : 'pointer',
                  textAlign: 'left',
                  fontSize: 12,
                }}
                onMouseEnter={(e) => { if (!current) e.currentTarget.style.background = 'var(--hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ fontWeight: 600 }}>{a.name}</span>
                {current && <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{t('terminal.account.menuCurrent')}</span>}
                {!current && a.paused && <span style={{ marginLeft: 'auto', color: 'var(--accent-amber)' }}>{t('terminal.account.menuPaused')}</span>}
              </button>
            );
          })}
        </div>
      )}
      <button
        onClick={onAdd}
        title={t('terminal.newTab')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          background: 'transparent',
          border: 'none',
          borderRadius: 6,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1,
          flexShrink: 0,
          transition: 'background 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(88, 166, 255, 0.12)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        +
      </button>
    </div>
  );
}
