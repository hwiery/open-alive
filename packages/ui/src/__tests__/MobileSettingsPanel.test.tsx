import '@testing-library/jest-dom/vitest';
import i18n from '@open-alive/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MobileSettingsPanel } from '../components/MobileSettingsPanel.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base = {
  active: { remoteEnabled: false, host: '127.0.0.1', terminalLevel: 'off' },
  saved: { remoteEnabled: false, bind: 'all', ticketRoots: [] as string[], terminalLevel: 'off' },
  restartRequired: false,
  canRestart: true,
  tokens: [] as string[],
  tailscale: { installed: true, running: true, ip: '100.105.20.8', dnsName: 'mac.tail.ts.net' },
  port: 3141,
};

function stub(view: typeof base, onPost?: (path: string, body: unknown) => unknown) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      const out = onPost?.(path, body) ?? view;
      return { ok: true, status: 200, json: async () => out } as Response;
    }
    return { ok: true, status: 200, json: async () => view } as Response;
  }));
  return calls;
}

describe('MobileSettingsPanel', () => {
  it('walks through four steps, with Tailscale download links and its status', async () => {
    stub(base);
    render(<MobileSettingsPanel active />);
    await screen.findByTestId('mobile-step-1');
    for (const n of [1, 2, 3, 4]) expect(screen.getByTestId(`mobile-step-${n}`)).toBeInTheDocument();
    expect(screen.getByTestId('mobile-step-1')).toHaveTextContent('100.105.20.8');
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['https://tailscale.com/download', 'https://apps.apple.com/app/tailscale/id1470499037', 'https://play.google.com/store/apps/details?id=com.tailscale.ipn']));
    // Remote is off, so step 4 explains what is missing instead of showing an address.
    expect(screen.getByTestId('mobile-step-4')).toHaveTextContent(/3단계|step 3/);
  });

  it('creates a token and shows its value once', async () => {
    stub(base, (path, body) =>
      path.endsWith('/tokens') ? { label: (body as { label: string }).label, token: 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123' } : base,
    );
    render(<MobileSettingsPanel active />);
    fireEvent.change(await screen.findByLabelText(/토큰 이름|Token name/), { target: { value: 'phone' } });
    fireEvent.click(screen.getByRole('button', { name: /토큰 만들기|Create token/ }));
    const fresh = await screen.findByTestId('fresh-token');
    expect(fresh).toHaveTextContent('abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123');
    fireEvent.click(screen.getByRole('button', { name: /확인했어요|Got it/ }));
    expect(screen.queryByTestId('fresh-token')).toBeNull();
  });

  it('saves remote access and offers a restart when needed', async () => {
    let saved: unknown;
    const calls = stub({ ...base, tokens: ['phone'], saved: { ...base.saved, ticketRoots: ['/work'] } }, (path, body) => {
      if (path === '/api/settings/mobile') {
        saved = body;
        return { ...base, tokens: ['phone'], saved: { ...base.saved, remoteEnabled: true, ticketRoots: ['/work'] }, restartRequired: true };
      }
      return undefined;
    });
    render(<MobileSettingsPanel active />);
    fireEvent.click(await screen.findByLabelText(/원격 접속 사용|Use remote access/));
    fireEvent.click(screen.getByRole('button', { name: /^(저장|Save)$/ }));
    await waitFor(() => expect(calls).toContain('POST /api/settings/mobile'));
    expect(saved).toMatchObject({ remoteEnabled: true, ticketRoots: ['/work'] });
    expect(await screen.findByTestId('restart-required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /지금 재시작|Restart now/ })).toBeInTheDocument();
  });

  it('shows a refused save next to the Save button, translated from its code', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? ({ ok: false, status: 400, json: async () => ({ error: 'remote access needs a device token', code: 'needToken' }) } as Response)
        : ({ ok: true, status: 200, json: async () => base } as Response),
    ));
    render(<MobileSettingsPanel active />);
    fireEvent.click(await screen.findByLabelText(/원격 접속 사용|Use remote access/));
    fireEvent.click(screen.getByRole('button', { name: /^(저장|Save)$/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(i18n.t('settings.mobile.errors.needToken'));
    expect(screen.getByTestId('mobile-step-3')).toContainElement(alert);
  });

  it('shows a refused token next to the token form and keeps unsaved choices', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? ({ ok: false, status: 400, json: async () => ({ error: 'exists', code: 'duplicateLabel', params: { name: 'phone' } }) } as Response)
        : ({ ok: true, status: 200, json: async () => base } as Response),
    ));
    render(<MobileSettingsPanel active />);
    const remote = await screen.findByLabelText(/원격 접속 사용|Use remote access/);
    fireEvent.click(remote);
    fireEvent.click(screen.getByRole('button', { name: /토큰 만들기|Create token/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(i18n.t('settings.mobile.errors.duplicateLabel', { name: 'phone' }));
    expect(screen.getByTestId('mobile-step-2')).toContainElement(alert);
    expect(remote).toBeChecked();
  });

  it('keeps unsaved choices when a new token refreshes the panel', async () => {
    stub(base, (path) => (path.endsWith('/tokens') ? { label: 'phone', token: 'abc' } : base));
    render(<MobileSettingsPanel active />);
    const remote = await screen.findByLabelText(/원격 접속 사용|Use remote access/);
    fireEvent.click(remote);
    fireEvent.click(screen.getByRole('button', { name: /토큰 만들기|Create token/ }));
    await screen.findByTestId('fresh-token');
    expect(remote).toBeChecked();
  });

  it('says the server is unreachable when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<MobileSettingsPanel active />);
    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('settings.mobile.errors.network'));
  });
});
