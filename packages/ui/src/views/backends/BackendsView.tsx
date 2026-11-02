import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { BackendStatus } from '@open-alive/core';
import { loadPresets, createPreset, deletePreset, buildSSHCommand, presetTarget, type SSHPreset } from '../chat/sshPresets.ts';
import { CLAUDE_MODELS_CHANGED_EVENT } from '../../hooks/useClaudeModels.ts';

/** The connection everything else builds on; checked before any other backend. */
const CLAUDE_ID = 'claude-local';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

interface BackendsPanelProps {
  /** Load + refresh the backend list when this becomes true (e.g. its tab opens). */
  active: boolean;
  /** Rendered right below the Claude card (the optional additional-API form). */
  gatewaySlot?: ReactNode;
  /** Hide the SSH host list (onboarding shows only the connection steps). */
  hideSsh?: boolean;
}

/** POST a single backend check; null on any failure. Notifies model listeners after a Claude check. */
async function checkOne(id: string): Promise<BackendStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/api/backends/${id}/check`, { method: 'POST' });
    if (!res.ok) return null;
    const { status } = (await res.json()) as { status: BackendStatus };
    if (id === CLAUDE_ID && status.connected) window.dispatchEvent(new CustomEvent(CLAUDE_MODELS_CHANGED_EVENT));
    return status;
  } catch {
    return null;
  }
}

/**
 * Backend connection surface. Lives inside the Settings modal (backend tab).
 * Claude (the required base connection) comes first and is checked first — its
 * check also refreshes which models the ticket presets use. Below it sits the
 * optional additional API (gateway form + its status card), then SSH hosts.
 *
 * Renders as an embeddable stack (no full-height scroll wrapper) so the Settings
 * modal body owns scrolling.
 */
export function BackendsPanel({ active, gatewaySlot, hideSsh = false }: BackendsPanelProps) {
  const { t } = useTranslation();
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [checking, setChecking] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/backends`);
      const data = (await res.json()) as { backends: BackendStatus[] };
      // Keep check results already on screen: the list endpoint never carries them.
      setBackends((prev) => {
        const checked = new Map(prev.filter((b) => b.connected !== undefined).map((b) => [b.id, b]));
        return (data.backends ?? []).map((b) => checked.get(b.id) ?? b);
      });
    } catch {
      // leave as-is
    } finally {
      setLoading(false);
    }
  }, []);

  const check = useCallback(async (id: string) => {
    setChecking(id);
    try {
      const status = await checkOne(id);
      if (status) setBackends((prev) => prev.map((b) => (b.id === status.id ? status : b)));
    } finally {
      setChecking(null);
    }
  }, []);

  // Opening the panel verifies the Claude connection straight away.
  useEffect(() => {
    if (!active) return;
    void refresh().then(() => check(CLAUDE_ID));
  }, [active, refresh, check]);

  // A gateway saved in the form above adds or removes the litellm card.
  useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener('open-alive:gateway-changed', onChanged);
    return () => window.removeEventListener('open-alive:gateway-changed', onChanged);
  }, [refresh]);

  // The manual counterpart to the app's startup health check: Claude first,
  // then the rest together. SSH (location kind) is checked per-host below.
  const checkAll = useCallback(async () => {
    setCheckingAll(true);
    try {
      const claude = await checkOne(CLAUDE_ID);
      const others = backends.filter((b) => b.kind !== 'location' && b.id !== CLAUDE_ID);
      const updated = [claude, ...(await Promise.all(others.map((b) => checkOne(b.id))))];
      const byId = new Map(updated.filter((s): s is BackendStatus => s !== null).map((s) => [s.id, s]));
      setBackends((prev) => prev.map((b) => byId.get(b.id) ?? b));
    } finally {
      setCheckingAll(false);
    }
  }, [backends]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary, #8b949e)', lineHeight: 1.5 }}>
          {t('backends.subtitle')}
        </p>
        <button
          type="button"
          onClick={checkAll}
          disabled={checkingAll || backends.length === 0}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid var(--accent-blue, #58a6ff)',
            background: 'rgba(88,166,255,0.10)',
            color: 'var(--accent-blue, #58a6ff)',
            cursor: checkingAll ? 'wait' : 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {checkingAll ? t('backends.checking') : t('settings.backend.checkAll', { defaultValue: 'Check all' })}
        </button>
      </div>

      {loading && backends.length === 0 ? (
        <div style={{ fontSize: 13, opacity: 0.5 }}>{t('backends.loading')}</div>
      ) : (
        backends
          .filter((b) => b.id === CLAUDE_ID)
          .map((b) => (
            <BackendCard key={b.id} backend={b} required checking={checking === b.id || checkingAll} onCheck={() => check(b.id)} t={t} />
          ))
      )}

      {gatewaySlot}

      {backends
        .filter((b) => b.id !== CLAUDE_ID)
        .map((b) => (
          <BackendCard key={b.id} backend={b} checking={checking === b.id || checkingAll} onCheck={() => check(b.id)} t={t} />
        ))}

      {!hideSsh && <SshHosts t={t} />}
    </div>
  );
}

/**
 * SSH host registration (spec §6). Hosts registered here (with structured
 * host/user/port fields) become selectable ticket locations — the ticket
 * location picker reads exactly these presets. Stored in browser localStorage.
 */
interface HostCheck {
  connected?: boolean;
  detail?: string;
  checking?: boolean;
}

function SshHosts({ t }: { t: (key: string) => string }) {
  const [hosts, setHosts] = useState<SSHPreset[]>(() => loadPresets().flatMap((p) => { const target = presetTarget(p); return target ? [{ ...p, ...target }] : []; }));
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState('');
  const [checks, setChecks] = useState<Record<string, HostCheck>>({});

  const refresh = () => setHosts(loadPresets().flatMap((p) => { const target = presetTarget(p); return target ? [{ ...p, ...target }] : []; }));

  // Verify a specific host by asking the server to browse it over SSH. A returned
  // path means the connection + auth work; an error means it failed.
  const checkHost = async (h: SSHPreset) => {
    setChecks((c) => ({ ...c, [h.id]: { ...c[h.id], checking: true } }));
    try {
      const res = await fetch(`${API_BASE}/api/ssh/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssh: { host: h.host, user: h.user, port: h.port, identityFile: h.identityFile } }),
      });
      const data = (await res.json()) as { path?: string; error?: string };
      setChecks((c) => ({
        ...c,
        [h.id]: data.path && !data.error
          ? { connected: true, detail: data.path }
          : { connected: false, detail: data.error ?? 'failed' },
      }));
    } catch {
      setChecks((c) => ({ ...c, [h.id]: { connected: false, detail: 'connection failed' } }));
    }
  };

  const add = () => {
    if (!host.trim()) return;
    const p = port.trim() ? Number(port.trim()) : undefined;
    createPreset({
      label: label.trim() || (user.trim() ? `${user.trim()}@${host.trim()}` : host.trim()),
      command: buildSSHCommand({ host: host.trim(), user: user.trim() || undefined, port: p }),
      host: host.trim(),
      user: user.trim() || undefined,
      port: p,
      autoRun: true,
    });
    setLabel('');
    setHost('');
    setUser('');
    setPort('');
    refresh();
  };

  const remove = (id: string) => {
    deletePreset(id);
    refresh();
  };

  const inputStyle: React.CSSProperties = {
    fontSize: 12,
    padding: '7px 9px',
    borderRadius: 8,
    border: '1px solid var(--border-default, #30363d)',
    background: 'var(--bg-primary, #0d1117)',
    color: 'var(--text-primary, #e6edf3)',
    minWidth: 0,
  };

  return (
    <div
      style={{
        background: 'var(--bg-secondary, #161b22)',
        border: '1px solid var(--border-default, #30363d)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #e6edf3)' }}>{t('backends.sshHosts')}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary, #8b949e)', marginTop: 3, lineHeight: 1.5 }}>
          {t('backends.sshHostsHint')}
        </div>
      </div>

      {hosts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {hosts.map((h) => {
            const st = checks[h.id];
            const dot =
              st?.connected === true
                ? 'var(--accent-green, #3fb950)'
                : st?.connected === false
                  ? 'var(--accent-red, #f85149)'
                  : 'var(--text-secondary, #8b949e)';
            return (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
              <span style={{ fontWeight: 600, color: 'var(--accent-purple, #bc8cff)' }}>⬈ {h.label}</span>
              <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-secondary, #8b949e)', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={st?.detail}>
                {h.user ? `${h.user}@${h.host}` : h.host}
                {h.port && h.port !== 22 ? `:${h.port}` : ''}
                {st?.connected === true && st.detail ? `  →  ${st.detail}` : ''}
                {st?.connected === false && st.detail ? `  →  ${st.detail}` : ''}
              </span>
              <button
                type="button"
                onClick={() => checkHost(h)}
                disabled={st?.checking}
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--accent-blue, #58a6ff)',
                  background: 'rgba(88,166,255,0.10)',
                  color: 'var(--accent-blue, #58a6ff)',
                  cursor: st?.checking ? 'wait' : 'pointer',
                  flexShrink: 0,
                }}
              >
                {st?.checking ? t('backends.checking') : t('backends.check')}
              </button>
              <button
                type="button"
                onClick={() => remove(h.id)}
                style={{
                  fontSize: 11,
                  padding: '3px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border-default, #30363d)',
                  background: 'transparent',
                  color: 'var(--accent-red, #f85149)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {t('backends.remove')}
              </button>
            </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1.6fr 1fr 0.7fr auto', gap: 8, alignItems: 'center' }}>
        <input style={inputStyle} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('backends.sshLabel')} />
        <input style={inputStyle} value={host} onChange={(e) => setHost(e.target.value)} placeholder={t('backends.sshHost')} />
        <input style={inputStyle} value={user} onChange={(e) => setUser(e.target.value)} placeholder={t('backends.sshUser')} />
        <input style={inputStyle} value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" inputMode="numeric" />
        <button
          type="button"
          onClick={add}
          disabled={!host.trim()}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '7px 14px',
            borderRadius: 8,
            border: 'none',
            background: host.trim() ? 'var(--accent-blue, #58a6ff)' : 'var(--bg-tertiary, #21262d)',
            color: host.trim() ? 'var(--on-accent)' : 'var(--text-secondary, #8b949e)',
            cursor: host.trim() ? 'pointer' : 'not-allowed',
            whiteSpace: 'nowrap',
          }}
        >
          {t('backends.sshAdd')}
        </button>
      </div>
    </div>
  );
}

function BackendCard({
  backend,
  required = false,
  checking,
  onCheck,
  t,
}: {
  backend: BackendStatus;
  /** Marks the base connection (Claude) that the rest of the app depends on. */
  required?: boolean;
  checking: boolean;
  onCheck: () => void;
  t: (key: string) => string;
}) {
  const dotColor =
    backend.connected === true
      ? 'var(--accent-green, #3fb950)'
      : backend.connected === false
        ? 'var(--accent-red, #f85149)'
        : 'var(--text-secondary, #8b949e)';
  const statusText =
    backend.connected === true ? t('backends.connected') : backend.connected === false ? t('backends.failed') : t('backends.unknown');

  return (
    <div
      style={{
        background: 'var(--bg-secondary, #161b22)',
        border: '1px solid var(--border-default, #30363d)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #e6edf3)' }}>{t(`backends.label.${backend.id}`)}</span>
          {required && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--accent-blue, #58a6ff)',
                border: '1px solid var(--accent-blue, #58a6ff)',
                borderRadius: 5,
                padding: '0 6px',
              }}
            >
              {t('backends.required')}
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--text-secondary, #8b949e)',
              background: 'var(--surface-2)',
              borderRadius: 5,
              padding: '1px 6px',
            }}
          >
            {t(`backends.kind.${backend.kind}`)}
          </span>
          <span style={{ fontSize: 11, color: dotColor, fontWeight: 600 }}>{statusText}</span>
        </div>
        {backend.detail && (
          <div
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono, monospace)',
              color: 'var(--text-secondary, #8b949e)',
              opacity: 0.75,
              marginTop: 3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={backend.detail}
          >
            {backend.detail}
          </div>
        )}
      </div>
      {/* SSH is a location, not a single connectable endpoint — its hosts are
          checked individually in the SSH hosts list below. */}
      {backend.kind !== 'location' && (
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '7px 14px',
            borderRadius: 8,
            border: '1px solid var(--accent-blue, #58a6ff)',
            background: 'rgba(88,166,255,0.10)',
            color: 'var(--accent-blue, #58a6ff)',
            cursor: checking ? 'wait' : 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {checking ? t('backends.checking') : t('backends.check')}
        </button>
      )}
    </div>
  );
}
