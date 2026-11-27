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

  it('sits above the Settings modal it opens from', () => {
    render(<FolderPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    const backdrop = screen.getByText(i18n.t('tickets.pickerTitle')).closest('[style*="z-index"]') as HTMLElement;
    expect(Number(backdrop.style.zIndex)).toBeGreaterThan(1100); // SettingsModal's zIndex
  });

  it('Esc closes the picker without reaching a modal listening underneath', () => {
    const onClose = vi.fn();
    const underneath = vi.fn();
    window.addEventListener('keydown', underneath);
    render(<FolderPicker onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', underneath);
    expect(onClose).toHaveBeenCalled();
    expect(underneath).not.toHaveBeenCalled();
  });

  it.each([
    [400, { code: 'denied', path: '/w/locked' }, 'denied', { path: '/w/locked' }],
    [400, { code: 'notFound', path: '/w/gone' }, 'notFound', { path: '/w/gone' }],
    [403, { error: 'Route is not available to remote callers' }, 'localOnly', {}],
  ])('explains a %i listing failure (%j)', async (status, body, key, params) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => body })));
    render(<FolderPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t(`tickets.browseError.${key}`, params));
  });

  it('says the server is unreachable when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<FolderPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('tickets.browseError.network'));
  });

  it('keeps the last good folder listed when entering a subfolder fails', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('browsed')
        ? { ok: false, status: 400, json: async () => ({ code: 'denied', path: '/w/browsed' }) }
        : { ok: true, status: 200, json: async () => ({ path: '/w', dirs: [{ name: 'browsed', path: '/w/browsed' }] }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<FolderPicker onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTitle('/w/browsed'));
    expect(await screen.findByRole('alert')).toHaveTextContent('/w/browsed');
    expect(screen.getByTitle('/w/browsed')).toBeInTheDocument();
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
