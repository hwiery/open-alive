import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OnboardingModal, ONBOARDING_STORAGE_KEY, isOnboardingDone } from '../components/OnboardingModal.tsx';
import { CLAUDE_MODELS_CHANGED_EVENT } from '../hooks/useClaudeModels.ts';

function stubClaudeCheck(status: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === 'POST' && path === '/api/backends/claude-local/check') {
      return { ok: true, status: 200, json: async () => ({ status }) } as Response;
    }
    if (path === '/api/settings/gateway') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ baseUrl: null, hasKey: false, keyHint: null, defaultModel: null, hasModelsFile: false, active: false }),
      } as Response;
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** This environment's localStorage lacks the Storage methods, so inject one. */
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OnboardingModal', () => {
  it('checks Claude first and lists the models the CLI resolves to', async () => {
    const fetchMock = stubClaudeCheck({
      id: 'claude-local',
      label: 'Claude (local)',
      kind: 'orchestrator',
      connected: true,
      models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'],
      detail: '2.1.296 (Claude Code)',
    });
    const refreshed = vi.fn();
    window.addEventListener(CLAUDE_MODELS_CHANGED_EVENT, refreshed);
    render(<OnboardingModal open onClose={() => {}} />);

    expect(await screen.findByText('Opus 5.5')).toBeInTheDocument();
    expect(screen.getByText('Sonnet 5.5')).toBeInTheDocument();
    expect(screen.getByText('Fable 5.1')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/backends/claude-local/check');
    expect(refreshed).toHaveBeenCalled();
    window.removeEventListener(CLAUDE_MODELS_CHANGED_EVENT, refreshed);
  });

  it('shows install and login guidance when Claude is not reachable', async () => {
    stubClaudeCheck({ id: 'claude-local', label: 'Claude (local)', kind: 'orchestrator', connected: false, detail: 'claude not found on PATH' });
    render(<OnboardingModal open onClose={() => {}} />);
    expect(await screen.findByText('claude not found on PATH')).toBeInTheDocument();
    expect(screen.getByText('npm install -g @anthropic-ai/claude-code')).toBeInTheDocument();
  });

  it('walks to the optional additional API step and finishes, remembering it is done', async () => {
    stubClaudeCheck({ id: 'claude-local', label: 'Claude (local)', kind: 'orchestrator', connected: true, models: [] });
    const onClose = vi.fn();
    render(<OnboardingModal open onClose={onClose} />);
    await screen.findByTestId('onboarding-claude-status');

    fireEvent.click(screen.getByRole('button', { name: /^(다음|Next)$/ }));
    expect(await screen.findByTestId('gateway-settings')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /건너뛰기|skip/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^(시작하기|Start)$/ }));

    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('done');
    expect(isOnboardingDone()).toBe(true);
  });

  it('counts skipping as done so it does not reappear on every load', async () => {
    stubClaudeCheck({ id: 'claude-local', label: 'Claude (local)', kind: 'orchestrator', connected: true });
    const onClose = vi.fn();
    render(<OnboardingModal open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /나중에 하기|Later/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(isOnboardingDone()).toBe(true);
  });
});
