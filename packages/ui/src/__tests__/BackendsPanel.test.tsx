import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { BackendsPanel } from '../views/backends/BackendsView.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BackendsPanel', () => {
  it('puts Claude first, the additional API below it, and checks Claude on open', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/api/backends') {
          return {
            ok: true,
            json: async () => ({
              backends: [
                { id: 'claude-local', label: 'Claude (local)', kind: 'orchestrator' },
                { id: 'litellm', label: 'LLM gateway', kind: 'subagent' },
              ],
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({ status: { id: 'claude-local', label: 'Claude (local)', kind: 'orchestrator', connected: true, detail: 'ok' } }),
        } as Response;
      }),
    );
    render(<BackendsPanel active hideSsh gatewaySlot={<div data-testid="slot">slot</div>} />);

    const claude = await screen.findByText('Claude Code');
    const slot = screen.getByTestId('slot');
    const gateway = screen.getByText(/추가 API|Additional API/);
    expect(claude.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(gateway) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/^(필수|Required)$/)).toBeInTheDocument();

    await waitFor(() => expect(calls).toContain('POST /api/backends/claude-local/check'));
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /api/backends/claude-local/check']);
  });
});
