import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { FolderPicker } from '../views/tickets/FolderPicker.tsx';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

type Bind = 'all' | 'tailscale' | 'local';
type TerminalLevel = 'off' | 'watch' | 'input' | 'shell';

interface MobileView {
  active: { remoteEnabled: boolean; host: string; terminalLevel: TerminalLevel };
  saved: { remoteEnabled: boolean; bind: Bind; ticketRoots: string[]; terminalLevel: TerminalLevel };
  restartRequired: boolean;
  canRestart: boolean;
  tokens: string[];
  tailscale: { installed: boolean; running: boolean; ip: string | null; dnsName: string | null };
  port: number;
}

const LINKS = {
  download: 'https://tailscale.com/download',
  mac: 'https://tailscale.com/download/mac',
  windows: 'https://tailscale.com/download/windows',
  ios: 'https://apps.apple.com/app/tailscale/id1470499037',
  android: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
  machines: 'https://login.tailscale.com/admin/machines',
};

const TERMINAL_LEVELS: TerminalLevel[] = ['off', 'watch', 'input', 'shell'];
const RESTART_COMMAND = 'open-alive stop && open-alive start';

/** A refused request; `code` selects the translated `settings.mobile.errors.*` message. */
class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly params?: Record<string, string>;

  constructor(message: string, status: number, code?: string, params?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; params?: Record<string, string> };
  if (!res.ok) throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status, body.code, body.params);
  return body;
}

function useQr(text: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!text) {
      setSrc(null);
      return;
    }
    QRCode.toDataURL(text, { margin: 1, width: 168 })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [text]);
  return src;
}

/**
 * Settings → Mobile. A four-step guide to reach this dashboard from a phone
 * over Tailscale, with every setting the steps need editable in place:
 * 1. Tailscale on both devices · 2. a device token · 3. remote access · 4. open it on the phone.
 */
export function MobileSettingsPanel({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<MobileView | null>(null);
  // `scope` is the action that failed: the message is shown next to it, not at the top of a long panel.
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState('phone');
  const [fresh, setFresh] = useState<{ label: string; token: string } | null>(null);
  const [draft, setDraft] = useState<{ remoteEnabled: boolean; bind: Bind; ticketRoots: string[]; terminalLevel: TerminalLevel } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const describe = useCallback(
    (e: unknown): string => {
      if (e instanceof ApiError) {
        const code = e.code ?? (e.status === 401 || e.status === 403 ? 'localOnly' : null);
        const key = `settings.mobile.errors.${code}`;
        return code && i18n.exists(key) ? t(key, e.params) : e.message;
      }
      // fetch() itself only rejects when the server could not be reached.
      if (e instanceof TypeError) return t('settings.mobile.errors.network');
      return e instanceof Error ? e.message : String(e);
    },
    [t, i18n],
  );

  // keepDraft: a refresh mid-edit (new token, re-check) must not discard unsaved choices.
  const load = useCallback(
    async (keepDraft = false) => {
      try {
        const next = await api<MobileView>('/api/settings/mobile');
        setView(next);
        setDraft((d) => (keepDraft && d ? d : next.saved));
        setError(null);
      } catch (e) {
        setError({ scope: 'load', message: describe(e) });
      }
    },
    [describe],
  );

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError({ scope: key.split(':')[0]!, message: describe(e) });
    } finally {
      setBusy(null);
    }
  };

  const errorFor = (...scopes: string[]) =>
    error && scopes.includes(error.scope) ? (
      <div role="alert" style={{ ...hint, color: 'var(--accent-red)' }}>{error.message}</div>
    ) : null;

  const copy = (text: string, key: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const ip = view?.tailscale.ip ?? null;
  const phoneUrl = ip && view ? `http://${ip}:${view.port}` : null;
  // Fragment, not query: `#token=` is never sent to the server or written to its logs.
  const freshUrl = fresh && phoneUrl ? `${phoneUrl}/#token=${encodeURIComponent(fresh.token)}` : null;
  const phoneQr = useQr(phoneUrl);
  const freshQr = useQr(freshUrl);

  if (!view || !draft) {
    return errorFor('load') ?? <div style={hint}>{t('settings.mobile.loading')}</div>;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(view.saved);
  const tsState = !view.tailscale.installed ? 'missing' : !view.tailscale.running ? 'loggedOut' : 'ok';

  const save = () =>
    run('save', async () => {
      setView(await api<MobileView>('/api/settings/mobile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }));
    });

  const restart = () =>
    run('restart', async () => {
      await api('/api/settings/mobile/restart', { method: 'POST' });
      // launchd brings the server back after its 10s throttle; wait for it, then reload.
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const res = await fetch(`${API_BASE}/health`);
          if (res.ok && i > 2) break;
        } catch {
          // still restarting
        }
      }
      window.location.reload();
    });

  return (
    <div data-testid="mobile-settings" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={hint}>{t('settings.mobile.intro')}</div>
      {errorFor('load')}

      {/* 1. Tailscale */}
      <Step n={1} title={t('settings.mobile.step1.title')} status={tsState === 'ok' ? 'ok' : 'todo'} statusText={t(`settings.mobile.step1.state.${tsState}`, { ip: ip ?? '', dns: view.tailscale.dnsName ?? '' })}>
        <div style={hint}>{t('settings.mobile.step1.body')}</div>
        <ol style={list}>
          <li>
            {t('settings.mobile.step1.installHere')}{' '}
            <a href={LINKS.mac} target="_blank" rel="noreferrer" style={link}>{t('settings.mobile.step1.mac')}</a>
            {' · '}
            <a href={LINKS.windows} target="_blank" rel="noreferrer" style={link}>{t('settings.mobile.step1.windows')}</a>
            {' · '}
            <a href={LINKS.download} target="_blank" rel="noreferrer" style={link}>{t('settings.mobile.step1.allPlatforms')}</a>
          </li>
          <li>
            {t('settings.mobile.step1.installPhone')}{' '}
            <a href={LINKS.ios} target="_blank" rel="noreferrer" style={link}>{t('settings.mobile.step1.ios')}</a>
            {' · '}
            <a href={LINKS.android} target="_blank" rel="noreferrer" style={link}>{t('settings.mobile.step1.android')}</a>
          </li>
          <li>{t('settings.mobile.step1.sameAccount')}</li>
          <li>
            {t('settings.mobile.step1.checkDevices')}{' '}
            <a href={LINKS.machines} target="_blank" rel="noreferrer" style={link}>{t('settings.mobile.step1.adminConsole')}</a>
          </li>
        </ol>
        <div>
          <button type="button" style={ghost} disabled={busy !== null} onClick={() => void load(true)}>{t('settings.mobile.recheck')}</button>
        </div>
      </Step>

      {/* 2. Device token */}
      <Step n={2} title={t('settings.mobile.step2.title')} status={view.tokens.length > 0 ? 'ok' : 'todo'} statusText={t('settings.mobile.step2.count', { count: view.tokens.length })}>
        <div style={hint}>{t('settings.mobile.step2.body')}</div>
        {view.tokens.length > 0 && (
          <ul style={{ ...list, listStyle: 'none', paddingLeft: 0 }}>
            {view.tokens.map((name) => (
              <li key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={mono}>{name}</code>
                <button
                  type="button"
                  style={{ ...ghost, color: 'var(--accent-red)', marginLeft: 'auto' }}
                  disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm(t('settings.mobile.step2.confirmRevoke', { name }))) return;
                    void run(`revoke:${name}`, async () => {
                      setView(await api<MobileView>(`/api/settings/mobile/tokens/${encodeURIComponent(name)}`, { method: 'DELETE' }));
                    });
                  }}
                >
                  {t('settings.mobile.step2.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input aria-label={t('settings.mobile.step2.labelField')} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('settings.mobile.step2.labelPlaceholder')} style={input} />
          <button
            type="button"
            style={primary}
            disabled={busy !== null || !label.trim()}
            onClick={() =>
              void run('create', async () => {
                const created = await api<{ label: string; token: string }>('/api/settings/mobile/tokens', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ label: label.trim() }),
                });
                setFresh(created);
                await load(true);
              })
            }
          >
            {t('settings.mobile.step2.create')}
          </button>
        </div>
        {errorFor('create', 'revoke')}
        {fresh && (
          <div data-testid="fresh-token" style={{ ...box, borderColor: 'var(--accent-orange, #d29922)' }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{t('settings.mobile.step2.freshTitle', { name: fresh.label })}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{ ...mono, wordBreak: 'break-all', flex: 1 }}>{fresh.token}</code>
              <button type="button" style={ghost} onClick={() => copy(fresh.token, 'token')}>{copied === 'token' ? t('settings.mobile.copied') : t('settings.mobile.copy')}</button>
            </div>
            {freshQr && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <img src={freshQr} alt={t('settings.mobile.step2.qrAlt')} width={140} height={140} style={{ borderRadius: 8, background: '#fff' }} />
                <div style={hint}>{t('settings.mobile.step2.qrHint')}</div>
              </div>
            )}
            <div style={{ ...hint, color: 'var(--accent-orange, #d29922)' }}>{t('settings.mobile.step2.onceWarning')}</div>
            <div>
              <button type="button" style={ghost} onClick={() => setFresh(null)}>{t('settings.mobile.step2.done')}</button>
            </div>
          </div>
        )}
      </Step>

      {/* 3. Remote access */}
      <Step
        n={3}
        title={t('settings.mobile.step3.title')}
        status={view.active.remoteEnabled ? 'ok' : 'todo'}
        statusText={view.active.remoteEnabled ? t('settings.mobile.step3.on') : t('settings.mobile.step3.off')}
      >
        <div style={hint}>{t('settings.mobile.step3.body')}</div>
        <label style={check}>
          <input type="checkbox" checked={draft.remoteEnabled} onChange={(e) => setDraft({ ...draft, remoteEnabled: e.target.checked })} />
          {t('settings.mobile.step3.enable')}
        </label>

        <div style={field}>{t('settings.mobile.step3.roots')}</div>
        <div style={hint}>{t('settings.mobile.step3.rootsHint')}</div>
        {draft.ticketRoots.map((root) => (
          <div key={root} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={mono}>{root}</code>
            <button type="button" style={{ ...ghost, marginLeft: 'auto' }} onClick={() => setDraft({ ...draft, ticketRoots: draft.ticketRoots.filter((r) => r !== root) })}>
              {t('settings.mobile.remove')}
            </button>
          </div>
        ))}
        <div>
          <button type="button" style={ghost} onClick={() => setPickerOpen(true)}>{t('settings.mobile.step3.addRoot')}</button>
        </div>
        {errorFor('roots')}

        <div style={field}>{t('settings.mobile.step3.bind')}</div>
        {(['all', 'tailscale'] as const).map((b) => (
          <label key={b} style={check}>
            <input type="radio" name="mobile-bind" checked={draft.bind === b} disabled={b === 'tailscale' && !ip} onChange={() => setDraft({ ...draft, bind: b })} />
            <span>
              {t(`settings.mobile.step3.bind_${b}`, { ip: ip ?? '-' })}
              <span style={{ ...hint, display: 'block' }}>{t(`settings.mobile.step3.bind_${b}Hint`)}</span>
            </span>
          </label>
        ))}

        <div style={field}>{t('settings.mobile.step3.terminal')}</div>
        <select value={draft.terminalLevel} onChange={(e) => setDraft({ ...draft, terminalLevel: e.target.value as TerminalLevel })} style={input}>
          {TERMINAL_LEVELS.map((lv) => (
            <option key={lv} value={lv}>{t(`settings.mobile.step3.terminal_${lv}`)}</option>
          ))}
        </select>
        {draft.terminalLevel !== 'off' && <div style={{ ...hint, color: 'var(--accent-orange, #d29922)' }}>{t(`settings.mobile.step3.terminalRisk_${draft.terminalLevel}`)}</div>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={primary} disabled={busy !== null || !dirty} onClick={save}>{t('settings.mobile.save')}</button>
          {dirty && <span style={hint}>{t('settings.mobile.unsaved')}</span>}
        </div>
        {errorFor('save')}
        {view.restartRequired && (
          <div data-testid="restart-required" style={{ ...box, borderColor: 'var(--accent-blue)' }}>
            <div style={{ fontSize: 12 }}>{t('settings.mobile.restartRequired')}</div>
            {view.canRestart ? (
              <div>
                <button type="button" style={primary} disabled={busy !== null} onClick={restart}>
                  {busy === 'restart' ? t('settings.mobile.restarting') : t('settings.mobile.restartNow')}
                </button>
              </div>
            ) : (
              <code style={mono}>{RESTART_COMMAND}</code>
            )}
            {errorFor('restart')}
          </div>
        )}
      </Step>

      {/* 4. Phone */}
      <Step n={4} title={t('settings.mobile.step4.title')} status={phoneUrl && view.active.remoteEnabled ? 'ok' : 'todo'} statusText={phoneUrl ?? t('settings.mobile.step4.noAddress')}>
        {!view.active.remoteEnabled ? (
          <div style={hint}>{t('settings.mobile.step4.needRemote')}</div>
        ) : !phoneUrl ? (
          <div style={hint}>{t('settings.mobile.step4.needTailscale')}</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {phoneQr && <img src={phoneQr} alt={t('settings.mobile.step4.qrAlt')} width={140} height={140} style={{ borderRadius: 8, background: '#fff' }} />}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <code style={mono}>{phoneUrl}</code>
                <div>
                  <button type="button" style={ghost} onClick={() => copy(phoneUrl, 'url')}>{copied === 'url' ? t('settings.mobile.copied') : t('settings.mobile.copy')}</button>
                </div>
              </div>
            </div>
            <ol style={list}>
              <li>{t('settings.mobile.step4.s1')}</li>
              <li>{t('settings.mobile.step4.s2')}</li>
              <li>{t('settings.mobile.step4.s3')}</li>
              <li>{t('settings.mobile.step4.s4')}</li>
            </ol>
            <div style={{ ...hint, color: 'var(--accent-orange, #d29922)' }}>{t('settings.mobile.step4.useTailscaleAddress')}</div>
          </>
        )}
      </Step>

      {pickerOpen && (
        <FolderPicker
          onSelect={(path) => {
            if (draft.ticketRoots.includes(path)) {
              setError({ scope: 'roots', message: t('settings.mobile.errors.rootDuplicate', { path }) });
              return;
            }
            setError(null);
            setDraft({ ...draft, ticketRoots: [...draft.ticketRoots, path] });
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function Step({ n, title, status, statusText, children }: { n: number; title: string; status: 'ok' | 'todo'; statusText: string; children: ReactNode }) {
  return (
    <section data-testid={`mobile-step-${n}`} style={{ ...box, gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700,
            background: status === 'ok' ? 'var(--accent-green)' : 'var(--surface-2)',
            color: status === 'ok' ? 'var(--on-accent)' : 'var(--text-secondary)',
            border: '1px solid var(--border-color)',
          }}
        >
          {status === 'ok' ? '✓' : n}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: status === 'ok' ? 'var(--accent-green)' : 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{statusText}</span>
      </div>
      {children}
    </section>
  );
}

const hint: React.CSSProperties = { fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 };
const field: React.CSSProperties = { fontSize: 12, fontWeight: 600, marginTop: 4 };
const list: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.8, color: 'var(--text-primary)' };
const link: React.CSSProperties = { color: 'var(--accent-blue)' };
const check: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, cursor: 'pointer' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)' };
const box: React.CSSProperties = {
  padding: 14,
  background: 'var(--surface-1)',
  border: '1px solid var(--border-color)',
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const input: React.CSSProperties = {
  flex: 1,
  padding: '7px 10px',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: 12,
};
const ghost: React.CSSProperties = {
  padding: '5px 10px',
  background: 'transparent',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontSize: 12,
};
const primary: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--accent-blue)',
  border: '1px solid var(--accent-blue)',
  borderRadius: 8,
  color: 'var(--on-accent)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
};
