import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { BackendStatus } from '@open-alive/core';
import { GatewaySettingsForm } from './GatewaySettingsForm.tsx';
import { CLAUDE_MODELS_CHANGED_EVENT } from '../hooks/useClaudeModels.ts';
import { modelLabel } from '../views/tickets/runPresets.ts';

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port || '3141'}`;

/** Bump the suffix when the onboarding gains a step everyone should see again. */
export const ONBOARDING_STORAGE_KEY = 'open-alive:onboarding:v1';
/** Dispatch to reopen the onboarding (Settings → Backend). */
export const OPEN_ONBOARDING_EVENT = 'open-alive:open-onboarding';

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === 'done';
  } catch {
    return true; // storage blocked: never trap the user in a modal
  }
}

function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'done');
  } catch {
    // storage blocked — the modal simply shows again next time
  }
}

type Step = 'claude' | 'gateway' | 'done';
const STEPS: readonly Step[] = ['claude', 'gateway', 'done'];

/** `httpStatus` is set when the check request itself failed (rendered via i18n). */
type ClaudeCheck =
  | { state: 'checking' }
  | { state: 'ok'; status: BackendStatus }
  | { state: 'failed'; detail: string; httpStatus?: number };

interface OnboardingModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * First-run setup. Step 1 connects Claude Code — the base everything runs on —
 * and, once the CLI answers, shows which models its tiers currently resolve to
 * (the same check refreshes the ticket presets). Step 2 offers the optional
 * additional API (any OpenAI-compatible gateway the user enters). Closing at
 * any point counts as done; Settings → Backend can reopen it.
 */
export function OnboardingModal({ open, onClose }: OnboardingModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('claude');
  const [claude, setClaude] = useState<ClaudeCheck>({ state: 'checking' });
  // Optional second engine; never blocks the flow.
  const [codex, setCodex] = useState<BackendStatus | null>(null);

  // Each check gets a sequence number; a late answer from an earlier one is dropped.
  const checkSeq = useRef(0);
  const checkClaude = useCallback(async () => {
    const seq = ++checkSeq.current;
    const apply = (next: ClaudeCheck) => {
      if (seq === checkSeq.current) setClaude(next);
    };
    apply({ state: 'checking' });
    try {
      const res = await fetch(`${API_BASE}/api/backends/claude-local/check`, { method: 'POST' });
      if (!res.ok) {
        apply({ state: 'failed', detail: '', httpStatus: res.status });
        return;
      }
      const { status } = (await res.json()) as { status: BackendStatus };
      if (status.connected) {
        apply({ state: 'ok', status });
        window.dispatchEvent(new CustomEvent(CLAUDE_MODELS_CHANGED_EVENT));
        void fetch(`${API_BASE}/api/backends/codex-local/check`, { method: 'POST' })
          .then(async (r) => (r.ok ? ((await r.json()) as { status: BackendStatus }).status : null))
          .then((codexStatus) => {
            if (seq === checkSeq.current) setCodex(codexStatus);
          })
          .catch(() => {});
      } else {
        apply({ state: 'failed', detail: status.detail ?? '' });
      }
    } catch (error) {
      apply({ state: 'failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  // Reset only when the modal opens — not when `t` or anything else changes mid-flow.
  useEffect(() => {
    if (!open) {
      checkSeq.current += 1;
      return;
    }
    setStep('claude');
    void checkClaude();
  }, [open, checkClaude]);

  const finish = useCallback(() => {
    markOnboardingDone();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish]);

  if (!open) return null;

  const stepIndex = STEPS.indexOf(step);

  return createPortal(
    <div style={overlayStyle}>
      <div role="dialog" aria-modal="true" aria-labelledby="onboarding-title" data-testid="onboarding" style={panelStyle}>
        <div style={headerStyle}>
          <div>
            <div id="onboarding-title" style={{ fontSize: 15, fontWeight: 600 }}>{t('onboarding.title')}</div>
            <div style={hintStyle}>{t('onboarding.stepOf', { current: stepIndex + 1, total: STEPS.length })}</div>
          </div>
          <button type="button" onClick={finish} title={t('onboarding.skipAll')} style={ghostBtn}>
            {t('onboarding.skipAll')}
          </button>
        </div>

        <div style={bodyStyle}>
          {step === 'claude' && (
            <>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t('onboarding.claude.title')}</div>
              <div style={hintStyle}>{t('onboarding.claude.hint')}</div>
              <ClaudeStatus check={claude} t={t} />
              {codex && (
                <div data-testid="onboarding-codex-status" style={boxStyle}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{t('onboarding.claude.codexTitle')}</div>
                  <div style={hintStyle}>{t('onboarding.claude.codexHint')}</div>
                  <div style={{ fontSize: 12, color: codex.connected ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
                    {codex.connected ? t('onboarding.claude.codexConnected') : t('onboarding.claude.codexMissing')}
                  </div>
                  {codex.connected && (codex.models ?? []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(codex.models ?? []).map((m) => (
                        <span key={m} title={m} style={chipStyle}>{m}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {step === 'gateway' && (
            <>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t('onboarding.gateway.title')}</div>
              <div style={hintStyle}>{t('onboarding.gateway.hint')}</div>
              <GatewaySettingsForm active />
            </>
          )}
          {step === 'done' && (
            <>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t('onboarding.done.title')}</div>
              <div style={hintStyle}>
                {claude.state === 'ok' ? t('onboarding.done.ready') : t('onboarding.done.claudeMissing')}
              </div>
              <div style={hintStyle}>{t('onboarding.done.reopen')}</div>
            </>
          )}
        </div>

        <div style={footerStyle}>
          {step !== 'claude' ? (
            <button type="button" style={ghostBtn} onClick={() => setStep(STEPS[stepIndex - 1]!)}>
              {t('onboarding.back')}
            </button>
          ) : (
            <button type="button" style={ghostBtn} disabled={claude.state === 'checking'} onClick={() => void checkClaude()}>
              {claude.state === 'checking' ? t('onboarding.claude.checking') : t('onboarding.claude.recheck')}
            </button>
          )}
          {step === 'done' ? (
            <button type="button" style={primaryBtn} onClick={finish}>{t('onboarding.start')}</button>
          ) : (
            <button type="button" style={primaryBtn} onClick={() => setStep(STEPS[stepIndex + 1]!)}>
              {step === 'gateway' ? t('onboarding.gateway.next') : t('onboarding.next')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ClaudeStatus({ check, t }: { check: ClaudeCheck; t: (key: string, opts?: Record<string, unknown>) => string }) {
  if (check.state === 'checking') {
    return <div data-testid="onboarding-claude-status" style={boxStyle}>{t('onboarding.claude.checking')}</div>;
  }
  if (check.state === 'failed') {
    return (
      <div data-testid="onboarding-claude-status" style={{ ...boxStyle, borderColor: 'var(--accent-red)' }}>
        <div style={{ color: 'var(--accent-red)', fontWeight: 600, fontSize: 12 }}>{t('onboarding.claude.failed')}</div>
        {check.httpStatus !== undefined && (
          <div style={monoStyle}>{t('onboarding.claude.checkFailed', { status: check.httpStatus })}</div>
        )}
        {check.detail && <div style={monoStyle}>{check.detail}</div>}
        <div style={hintStyle}>{t('onboarding.claude.installHint')}</div>
        <code style={monoStyle}>npm install -g @anthropic-ai/claude-code</code>
        <div style={hintStyle}>{t('onboarding.claude.loginHint')}</div>
        <code style={monoStyle}>claude</code>
      </div>
    );
  }
  const models = check.status.models ?? [];
  return (
    <div data-testid="onboarding-claude-status" style={{ ...boxStyle, borderColor: 'var(--accent-green)' }}>
      <div style={{ color: 'var(--accent-green)', fontWeight: 600, fontSize: 12 }}>{t('onboarding.claude.connected')}</div>
      {models.length > 0 && (
        <>
          <div style={hintStyle}>{t('onboarding.claude.models')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {models.map((m) => (
              <span key={m} title={m} style={chipStyle}>{modelLabel(m)}</span>
            ))}
          </div>
        </>
      )}
      {check.status.detail && <div style={monoStyle}>{check.status.detail}</div>}
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1150,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.6)',
  backdropFilter: 'blur(2px)',
};
const panelStyle: React.CSSProperties = {
  width: 'min(620px, 94vw)',
  maxHeight: '88vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 14,
  overflow: 'hidden',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-ui)',
  boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
};
const headerStyle: React.CSSProperties = {
  padding: '14px 18px',
  borderBottom: '1px solid var(--border-color)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};
const bodyStyle: React.CSSProperties = { padding: 20, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' };
const footerStyle: React.CSSProperties = {
  padding: '12px 18px',
  borderTop: '1px solid var(--border-color)',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
};
const hintStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 };
const boxStyle: React.CSSProperties = {
  padding: 14,
  borderRadius: 12,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-1)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontSize: 12,
};
const monoStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-secondary)',
  wordBreak: 'break-all',
};
const chipStyle: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-2)',
  color: 'var(--text-primary)',
};
const ghostBtn: React.CSSProperties = {
  padding: '6px 12px',
  background: 'transparent',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
};
const primaryBtn: React.CSSProperties = {
  padding: '6px 16px',
  background: 'var(--accent-blue)',
  border: '1px solid var(--accent-blue)',
  borderRadius: 8,
  color: 'var(--on-accent)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
};
