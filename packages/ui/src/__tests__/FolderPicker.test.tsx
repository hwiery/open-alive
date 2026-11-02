import '@testing-library/jest-dom/vitest';
import i18n from '@open-alive/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderPicker } from '../views/tickets/FolderPicker.tsx';
import { RemoteFolderPicker } from '../views/tickets/RemoteFolderPicker.tsx';

const RECENT_KEY = 'open-alive:recent-folders:v1';

beforeEach(() => {
  // jsdom here ships no working localStorage; a Map-backed one per test.
  const store = new Map<string, string>([[RECENT_KEY, JSON.stringify(['/w/recent-app'])]]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ path: '/w', dirs: [{ name: 'browsed', path: '/w/browsed' }] }),
  })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ticket FolderPicker', () => {
  it('shows quick select, recent folders and browse side by side', async () => {
    render(<FolderPicker quick={['/w/live-app']} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(i18n.t('terminal.quickSelect'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('terminal.menu.recentFolders'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('terminal.browseSection'))).toBeInTheDocument();
    expect(await screen.findByTitle('/w/browsed')).toBeInTheDocument();
  });

  it('picks a quick-select folder and closes', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<FolderPicker quick={['/w/live-app']} onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByTitle('/w/live-app'));
    expect(onSelect).toHaveBeenCalledWith('/w/live-app');
    expect(onClose).toHaveBeenCalled();
  });

  it('uses the browsed folder from the footer', async () => {
    const onSelect = vi.fn();
    render(<FolderPicker onSelect={onSelect} onClose={vi.fn()} />);
    await screen.findByTitle('/w/browsed');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('tickets.useThisFolder') }));
    expect(onSelect).toHaveBeenCalledWith('/w');
  });

  it('has no quick-select column when no active folders are passed', () => {
    render(<FolderPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText(i18n.t('terminal.quickSelect'))).not.toBeInTheDocument();
    expect(screen.getByTitle('/w/recent-app')).toBeInTheDocument();
  });
});

describe('ticket RemoteFolderPicker', () => {
  it('lays the remote host out the same way, without a quick-select column', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ path: '/home/dev', dirs: ['app'] }) })));
    const onSelect = vi.fn();
    render(<RemoteFolderPicker ssh={{ host: '10.0.0.2', user: 'build' }} onSelect={onSelect} onClose={vi.fn()} />);
    expect(screen.getByText(i18n.t('terminal.menu.recentFolders'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('terminal.quickSelect'))).not.toBeInTheDocument();
    fireEvent.doubleClick(await screen.findByTitle('/home/dev/app'));
    expect(onSelect).toHaveBeenCalledWith('/home/dev/app');
  });
});
