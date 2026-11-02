import { describe, it, expect } from 'vitest';
import { shouldCollapseTerminalOnViewSelect } from '../state/terminalViewSwitch';

describe('shouldCollapseTerminalOnViewSelect', () => {
  it('minimises a visible fullscreen terminal when a covered view is picked', () => {
    for (const view of ['tickets', 'animation', 'board', 'workspace'] as const) {
      expect(shouldCollapseTerminalOnViewSelect(true, 'fullscreen', view), view).toBe(true);
    }
  });

  it('treats legacy board modes like the board', () => {
    expect(shouldCollapseTerminalOnViewSelect(true, 'fullscreen', 'prompt')).toBe(true);
  });

  it('keeps the terminal for views that embed it', () => {
    expect(shouldCollapseTerminalOnViewSelect(true, 'fullscreen', 'list')).toBe(false);
    expect(shouldCollapseTerminalOnViewSelect(true, 'fullscreen', 'spread')).toBe(false);
  });

  it('leaves non-fullscreen or hidden terminals alone', () => {
    expect(shouldCollapseTerminalOnViewSelect(true, 'popup', 'tickets')).toBe(false);
    expect(shouldCollapseTerminalOnViewSelect(true, 'bottom', 'animation')).toBe(false);
    expect(shouldCollapseTerminalOnViewSelect(false, 'fullscreen', 'tickets')).toBe(false);
  });
});
