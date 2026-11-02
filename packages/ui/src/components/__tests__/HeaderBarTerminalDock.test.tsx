import '@open-alive/i18n';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ViewMode } from '../../App.tsx';
import { HeaderBar } from '../HeaderBar.tsx';

afterEach(cleanup);

const renderHeader = (viewMode: ViewMode, onTerminalPanelPosition = vi.fn(), onToggleChat = vi.fn()) =>
  render(
    <HeaderBar
      viewMode={viewMode}
      onViewModeChange={() => {}}
      terminalPanelMode="bottom"
      onTerminalPanelPosition={onTerminalPanelPosition}
      onToggleChat={onToggleChat}
      chatOpen
    />,
  );

describe('HeaderBar terminal dock controls', () => {
  it('lets the tickets view place and toggle the terminal without leaving it', () => {
    const place = vi.fn();
    const toggle = vi.fn();
    renderHeader('tickets', place, toggle);

    const group = screen.getByTestId('terminal-position');
    const buttons = group.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect(group.querySelector('[aria-pressed="true"]')).toBe(buttons[1]);
    fireEvent.click(buttons[2]);
    expect(place).toHaveBeenCalledWith('right');

    fireEvent.click(screen.getByTestId('terminal-toggle'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('keeps the controls in the window layout', () => {
    renderHeader('animation');
    expect(screen.getByTestId('terminal-position')).toBeTruthy();
    expect(screen.getByTestId('terminal-toggle')).toBeTruthy();
  });

  it('hides them where the terminal is the body or a tool is open', () => {
    for (const view of ['list', 'spread', 'board'] as const) {
      renderHeader(view);
      expect(screen.queryByTestId('terminal-position'), view).toBeNull();
      expect(screen.queryByTestId('terminal-toggle'), view).toBeNull();
      cleanup();
    }
  });
});
