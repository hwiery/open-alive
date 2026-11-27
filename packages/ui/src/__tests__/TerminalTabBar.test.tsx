import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TerminalTabBar, type Tab } from '../views/chat/TerminalTabBar.js';

// Mock i18next so status labels resolve to predictable strings.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'terminal.newTab': 'New tab',
        'terminal.exited': 'Exited',
        'terminal.status.waiting': 'Waiting',
      };
      if (key === 'terminal.tabLabel' && opts?.n != null) return `Terminal ${opts.n}`;
      return map[key] ?? key;
    },
  }),
}));

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    label: 'my-project',
    exited: false,
    status: 'idle',
    source: 'local',
    ...overrides,
  };
}

describe('TerminalTabBar status label', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows a persistent "(Waiting)" status text when a tab is waiting on the user', () => {
    const tab = makeTab({ status: 'waiting' });
    render(
      <TerminalTabBar
        tabs={[tab]}
        activeTabId="t1"
        onSelect={() => {}}
        onAdd={() => {}}
        onClose={() => {}}
      />,
    );
    // The terminal name stays visible…
    expect(screen.getByText('my-project')).toBeTruthy();
    // …and the waiting status is surfaced textually so the user knows Claude
    // is asking for their decision (not just a subtle colour change).
    expect(screen.getByText(/Waiting/)).toBeTruthy();
  });

  it('does not show a waiting status text for an idle tab', () => {
    const tab = makeTab({ status: 'idle' });
    render(
      <TerminalTabBar
        tabs={[tab]}
        activeTabId="t1"
        onSelect={() => {}}
        onAdd={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Waiting/)).toBeNull();
  });

  describe('Claude accounts', () => {
    const choices = [{ name: 'default', paused: true }, { name: 'alt1', paused: false }];
    const noop = () => {};

    it('shows the account badge only with rotation on', () => {
      const tab = makeTab({ claudeSessionId: 's', claudeAccount: 'default' });
      const { rerender } = render(
        <TerminalTabBar tabs={[tab]} activeTabId="t1" onSelect={noop} onAdd={noop} onClose={noop} />,
      );
      expect(screen.queryByTestId('tab-account-t1')).toBeNull();
      rerender(
        <TerminalTabBar tabs={[tab]} activeTabId="t1" onSelect={noop} onAdd={noop} onClose={noop} accountChoices={choices} onSwitchAccount={noop} />,
      );
      expect(screen.getByTestId('tab-account-t1').textContent).toBe('default');
    });

    it('right-click offers the other accounts and switches', () => {
      const onSwitch = vi.fn();
      const tab = makeTab({ claudeSessionId: 's', claudeAccount: 'default' });
      render(
        <TerminalTabBar tabs={[tab]} activeTabId="t1" onSelect={noop} onAdd={noop} onClose={noop} accountChoices={choices} onSwitchAccount={onSwitch} />,
      );
      fireEvent.contextMenu(screen.getByText('my-project'));
      const menu = screen.getByTestId('tab-account-menu');
      const items = menu.querySelectorAll('[role="menuitem"]');
      expect(items).toHaveLength(2);
      expect((items[0] as HTMLButtonElement).disabled).toBe(true); // current
      fireEvent.click(items[1]!);
      expect(onSwitch).toHaveBeenCalledWith('t1', 'alt1');
      expect(screen.queryByTestId('tab-account-menu')).toBeNull();
    });

    it('has no account menu for shell or SSH tabs', () => {
      render(
        <TerminalTabBar
          tabs={[makeTab({ mode: 'shell', claudeSessionId: 's' }), makeTab({ id: 't2', label: 'remote', source: 'ssh', claudeSessionId: 'x' })]}
          activeTabId="t1" onSelect={noop} onAdd={noop} onClose={noop} accountChoices={choices} onSwitchAccount={vi.fn()}
        />,
      );
      fireEvent.contextMenu(screen.getByText('my-project'));
      fireEvent.contextMenu(screen.getByText('remote'));
      expect(screen.queryByTestId('tab-account-menu')).toBeNull();
    });
  });
});
