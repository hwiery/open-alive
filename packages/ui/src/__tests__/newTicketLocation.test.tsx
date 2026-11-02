import '@testing-library/jest-dom/vitest';
import i18n from '@open-alive/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TicketLocation } from '@open-alive/core';
import { NewTicketForm } from '../views/tickets/NewTicketForm.tsx';

// The SSH folder picker browses the host through the server; here it just
// reports which host it was opened for and picks a folder.
vi.mock('../views/tickets/RemoteFolderPicker.tsx', () => ({
  RemoteFolderPicker: ({ ssh, onSelect, onClose }: { ssh: { host: string }; onSelect: (p: string) => void; onClose: () => void }) => (
    <button type="button" data-testid="remote-picker" data-host={ssh.host} onClick={() => { onSelect('/home/dev/app'); onClose(); }}>
      pick
    </button>
  ),
}));

const REMOTE: TicketLocation = {
  kind: 'ssh',
  ssh: { host: '10.0.0.2', user: 'build' },
  label: 'builder',
};

afterEach(cleanup);

/** Fill the goal and submit; the create button is the only enabled one. */
function submit() {
  fireEvent.change(screen.getByPlaceholderText(i18n.t('tickets.newGoalPlaceholder')), { target: { value: '작업' } });
  fireEvent.click(screen.getByRole('button', { name: i18n.t('tickets.create') }));
}

describe('NewTicketForm location', () => {
  it('submits a sidebar-seeded remote path with its host, not as a local run', async () => {
    const onCreate = vi.fn(async () => null);
    render(<NewTicketForm onCreate={onCreate} presetCwd="/srv/app" presetLocation={REMOTE} />);

    expect(screen.getByTestId('ticket-remote-note')).toHaveTextContent('build@10.0.0.2');
    submit();
    expect(onCreate).toHaveBeenCalledWith('작업', '/srv/app', REMOTE, false, undefined, true, true, { model: 'claude-opus-5-5', effort: 'high' });
  });

  it('keeps a local selection local', async () => {
    const onCreate = vi.fn(async () => null);
    render(<NewTicketForm onCreate={onCreate} presetCwd="/r/alive" />);

    expect(screen.queryByTestId('ticket-remote-note')).toBeNull();
    submit();
    expect(onCreate).toHaveBeenCalledWith('작업', '/r/alive', undefined, true, undefined, true, true, { model: 'claude-opus-5-5', effort: 'high' });
  });
});

describe('NewTicketForm SSH presets from the terminal tab', () => {
  it('offers a free-form `ssh` preset as a location and runs the ticket there', async () => {
    const store = new Map<string, string>([[
      'open-alive:ssh-presets:v1',
      JSON.stringify([{ id: 'p1', label: 'studio', command: 'ssh dev@studio.local', autoRun: true, createdAt: 1, updatedAt: 1 }]),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      const onCreate = vi.fn(async () => null);
      render(<NewTicketForm onCreate={onCreate} presetCwd="/srv/app" />);
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toContain('p1');
      fireEvent.change(select, { target: { value: 'p1' } });
      // Same as Local: no path field, the folder button opens the (SSH) picker.
      expect(document.querySelector('input[type="text"]')).toBeNull();
      fireEvent.click(screen.getByTestId('ticket-folder-button'));
      const picker = screen.getByTestId('remote-picker');
      expect(picker).toHaveAttribute('data-host', 'studio.local');
      fireEvent.click(picker);
      submit();
      await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
      const location = (onCreate.mock.calls[0] as unknown[])[2] as TicketLocation;
      expect(location).toMatchObject({ kind: 'ssh', ssh: { host: 'studio.local', user: 'dev' } });
      expect((onCreate.mock.calls[0] as unknown[])[1]).toBe('/home/dev/app');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('NewTicketForm options', () => {
  it('folds the options by default, shows the model and effort in the summary, and expands on click', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      render(<NewTicketForm onCreate={vi.fn(async () => null)} />);
      const toggle = screen.getByTestId('ticket-options-toggle');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // Folded: kept mounted for the unfold animation, but hidden and inert.
      const region = screen.getByTestId('ticket-options');
      expect(region).toHaveAttribute('aria-hidden', 'true');
      expect(region).toHaveAttribute('inert');
      expect(region.style.gridTemplateRows).toBe('0fr');
      expect(toggle).toHaveTextContent('Opus 5.5');
      expect(toggle).toHaveTextContent('high');
      fireEvent.click(toggle);
      expect(region).toHaveAttribute('aria-hidden', 'false');
      expect(region).not.toHaveAttribute('inert');
      expect(region.style.gridTemplateRows).toBe('1fr');
      expect(region.style.transition).toContain('grid-template-rows');
      expect(screen.getByTestId('model-picker')).toBeInTheDocument();
      expect(store.get('open-alive:ticket-options-open')).toBe('1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
