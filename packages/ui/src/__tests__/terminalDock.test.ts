import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BOTTOM_HEIGHT,
  DEFAULT_RIGHT_WIDTH,
  DEFAULT_TERMINAL_MODE,
  TERMINAL_MODE_KEY,
  canDockTerminal,
  loadDockSize,
  loadTerminalMode,
  saveTerminalPref,
  terminalDockInsets,
} from '../state/terminalDock';

function memoryStorage(seed: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('loadTerminalMode', () => {
  it('docks the terminal at the bottom when nothing is saved', () => {
    expect(DEFAULT_TERMINAL_MODE).toBe('bottom');
    expect(loadTerminalMode(memoryStorage())).toBe('bottom');
    expect(loadTerminalMode(undefined)).toBe('bottom');
  });

  it('restores a saved panel position', () => {
    for (const mode of ['popup', 'bottom', 'right'] as const) {
      expect(loadTerminalMode(memoryStorage({ [TERMINAL_MODE_KEY]: mode }))).toBe(mode);
    }
  });

  it('ignores fullscreen and unknown values', () => {
    expect(loadTerminalMode(memoryStorage({ [TERMINAL_MODE_KEY]: 'fullscreen' }))).toBe('bottom');
    expect(loadTerminalMode(memoryStorage({ [TERMINAL_MODE_KEY]: 'nope' }))).toBe('bottom');
  });
});

describe('loadDockSize / saveTerminalPref', () => {
  it('round-trips a pixel size', () => {
    const storage = memoryStorage();
    saveTerminalPref(storage, 'k', 321.6);
    expect(loadDockSize(storage, 'k')).toBe(322);
  });

  it('returns undefined for missing or invalid sizes', () => {
    expect(loadDockSize(memoryStorage(), 'k')).toBeUndefined();
    expect(loadDockSize(memoryStorage({ k: 'abc' }), 'k')).toBeUndefined();
    expect(loadDockSize(memoryStorage({ k: '-5' }), 'k')).toBeUndefined();
    expect(loadDockSize(undefined, 'k')).toBeUndefined();
  });

  it('survives a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadTerminalMode(broken)).toBe('bottom');
    expect(() => saveTerminalPref(broken, 'k', 'x')).not.toThrow();
  });
});

describe('terminalDockInsets', () => {
  it('reserves the docked panel size so the view is not covered', () => {
    expect(terminalDockInsets(true, 'bottom', 300)).toEqual({ bottom: 300, right: 0 });
    expect(terminalDockInsets(true, 'right', undefined, 420)).toEqual({ bottom: 0, right: 420 });
  });

  it('falls back to the panel default size', () => {
    expect(terminalDockInsets(true, 'bottom')).toEqual({ bottom: DEFAULT_BOTTOM_HEIGHT, right: 0 });
    expect(terminalDockInsets(true, 'right')).toEqual({ bottom: 0, right: DEFAULT_RIGHT_WIDTH });
  });

  it('reserves nothing for a hidden, floating or fullscreen terminal', () => {
    expect(terminalDockInsets(false, 'bottom', 300)).toEqual({ bottom: 0, right: 0 });
    expect(terminalDockInsets(true, 'popup')).toEqual({ bottom: 0, right: 0 });
    expect(terminalDockInsets(true, 'fullscreen')).toEqual({ bottom: 0, right: 0 });
  });
});

describe('canDockTerminal', () => {
  it('offers the panel position in the window layout and the tickets view', () => {
    expect(canDockTerminal('animation')).toBe(true);
    expect(canDockTerminal('tickets')).toBe(true);
  });

  it('hides it where the terminal fills the body or a tool is open', () => {
    for (const view of ['list', 'spread', 'board'] as const) expect(canDockTerminal(view), view).toBe(false);
  });
});
