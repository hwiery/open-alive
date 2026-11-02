import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shell mounts the sidebar unconditionally; stub the network so the test
// exercises layout, not fetching.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ repositories: [], worktrees: [], runs: [] }),
  })));
  class FakeSocket {
    readyState = 0;
    close() {}
    send() {}
    addEventListener() {}
    removeEventListener() {}
  }
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  // jsdom ships neither of these; without them the lazy views throw and the
  // ErrorBoundary swallows the tree we are trying to measure.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App shell', () => {
  it('renders the repository sidebar', async () => {
    const { default: App } = await import('../App.tsx');
    render(<App />);
    expect(await screen.findByRole('navigation', { name: /repositor|레포/i })).toBeInTheDocument();
  });

  it('shows one left sidebar per view, never the repo tree next to the session list', async () => {
    const { default: App } = await import('../App.tsx');
    render(<App />);
    const repoNav = () => screen.queryByRole('navigation', { name: /repositor|레포/i });
    await waitFor(() => expect(repoNav()).toBeInTheDocument());
    // Terminal (window layout by default) renders its own session sidebar; the repo tree must not sit beside it.
    fireEvent.click(screen.getByRole('tab', { name: /^(terminal|터미널)$/i }));
    expect(screen.getByRole('tab', { name: /^(window|창)$/i })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(repoNav()).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /^(tickets|티켓)$/i }));
    await waitFor(() => expect(repoNav()).toBeInTheDocument());
  });

  it('shows the terminal layout toggle only in the terminal view, and reopens the last layout', async () => {
    const { default: App } = await import('../App.tsx');
    render(<App />);
    await screen.findByRole('navigation', { name: /repositor|레포/i });
    expect(screen.queryByRole('tab', { name: /^(split|분할)$/i })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^(terminal|터미널)$/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^(split|분할)$/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^(tickets|티켓)$/i }));
    expect(screen.queryByRole('tab', { name: /^(split|분할)$/i })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^(terminal|터미널)$/i }));
    expect(screen.getByRole('tab', { name: /^(split|분할)$/i })).toHaveAttribute('aria-selected', 'true');
    // Cost sits with the views, next to Tickets and Terminal.
    expect(screen.getByRole('tab', { name: /^(cost|비용)$/i })).toBeInTheDocument();
  });

  it('offers the terminal panel position in the header, for the tickets view and window layout', async () => {
    const { default: App } = await import('../App.tsx');
    render(<App />);
    await screen.findByRole('navigation', { name: /repositor|레포/i });
    // Tickets: the terminal can be docked below without leaving the view.
    expect(screen.getByTestId('terminal-position')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^(terminal|터미널)$/i }));
    const group = screen.getByTestId('terminal-position');
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('open-alive:terminal-set-mode', listener);
    fireEvent.click(buttons[1]!);
    window.removeEventListener('open-alive:terminal-set-mode', listener);
    expect(seen).toEqual(['bottom']);
    fireEvent.click(screen.getByRole('tab', { name: /^(split|분할)$/i }));
    expect(screen.queryByTestId('terminal-position')).toBeNull();
  });

  it('opens the to-do as a floating panel from the header, in any view', async () => {
    const { default: App } = await import('../App.tsx');
    render(<App />);
    await screen.findByRole('navigation', { name: /repositor|레포/i });
    // No docked to-do in the tickets view any more.
    expect(screen.queryByTestId('floating-todo')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^(to-do|할 일)$/i }));
    expect(screen.getByTestId('floating-todo')).toBeInTheDocument();
    // It follows the user into the terminal view.
    fireEvent.click(screen.getByRole('tab', { name: /^(terminal|터미널)$/i }));
    expect(screen.getByTestId('floating-todo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close to-do|할 일 닫기/i }));
    expect(screen.queryByTestId('floating-todo')).toBeNull();
  });
});
