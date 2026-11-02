import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

interface AccessView {
  remoteEnabled: boolean;
  requireTokenLocally: boolean;
}

/**
 * Settings → Backend → Access. Whether this computer must enter a token.
 * A token can only be required in remote mode; outside it the switch is shown
 * disabled with the reason, so "sometimes it asks, sometimes not" has an answer.
 */
export function AccessSettingsCard({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [view, setView] = useState<AccessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/settings/access`);
      if (res.status === 403) {
        setError(t('settings.access.localOnly'));
        return;
      }
      if (!res.ok) {
        setError(t('settings.access.unavailable'));
        return;
      }
      setView((await res.json()) as AccessView);
    } catch {
      setError(t('settings.access.unavailable'));
    }
  }, [t]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const change = async (requireTokenLocally: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/settings/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requireTokenLocally }),
      });
      if (!res.ok) {
        setError(t('settings.access.saveFailed'));
        return;
      }
      setView((await res.json()) as AccessView);
    } catch {
      setError(t('settings.access.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="access-settings" style={cardStyle}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.access.title')}</div>
      {error ? (
        <div role="alert" style={{ ...hintStyle, color: 'var(--accent-orange, #d29922)' }}>{error}</div>
      ) : view ? (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: view.remoteEnabled ? 'pointer' : 'not-allowed', opacity: view.remoteEnabled ? 1 : 0.6 }}>
            <input
              type="checkbox"
              checked={view.requireTokenLocally}
              disabled={!view.remoteEnabled || busy}
              onChange={(e) => void change(e.target.checked)}
            />
            {t('settings.access.requireTokenLocally')}
          </label>
          <div style={hintStyle}>
            {view.remoteEnabled
              ? view.requireTokenLocally
                ? t('settings.access.hintRequired')
                : t('settings.access.hintTrusted')
              : t('settings.access.hintRemoteOff')}
          </div>
          {view.remoteEnabled && !view.requireTokenLocally && (
            <div role="note" style={{ ...hintStyle, color: 'var(--accent-orange, #d29922)' }}>{t('settings.access.warning')}</div>
          )}
        </>
      ) : null}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: 14,
  background: 'var(--surface-1)',
  border: '1px solid var(--border-color)',
  borderRadius: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const hintStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 };
