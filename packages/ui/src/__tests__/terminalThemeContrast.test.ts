import { describe, it, expect, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
});

const {
  AUTO_TERMINAL_THEME_ID,
  DEFAULT_SETTINGS,
  TERMINAL_MIN_CONTRAST,
  TERMINAL_THEMES,
  displayTerminalTheme,
  effectiveTerminalBackground,
  getThemeById,
  resolveTerminalTheme,
} = await import('../services/settings');
const { contrastRatio, ensureContrast, isTransparent, parseColor } = await import('../services/contrast');
const { getAppTheme, subscribeAppTheme } = await import('../services/appearance');

const TEXT_SLOTS = [
  'foreground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta',
  'brightCyan', 'brightWhite',
] as const;

function ratio(fg: string, bg: string): number {
  return contrastRatio(parseColor(fg)!, parseColor(bg)!);
}

describe('contrast helpers', () => {
  it('computes WCAG ratios', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('pushes white text on white toward black until it is readable', () => {
    const fixed = ensureContrast('#ffffff', '#ffffff', 4.5);
    expect(ratio(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('leaves already-readable colours alone', () => {
    expect(ensureContrast('#1f2328', '#ffffff', 4.5)).toBe('#1f2328');
  });

  it('recognises transparent backgrounds', () => {
    expect(isTransparent('transparent')).toBe(true);
    expect(isTransparent('rgba(255, 255, 255, 0)')).toBe(true);
    expect(isTransparent('#ffffff')).toBe(false);
  });
});

describe('terminal theme per app theme', () => {
  it('defaults to following the app theme', () => {
    expect(DEFAULT_SETTINGS.terminal.themeId).toBe(AUTO_TERMINAL_THEME_ID);
  });

  it('auto gives a dark palette on the dark app theme', () => {
    expect(resolveTerminalTheme(AUTO_TERMINAL_THEME_ID, {}, 'dark')).toEqual(getThemeById('github-dark'));
  });

  it('auto gives a light palette with dark text on the light app theme', () => {
    const theme = resolveTerminalTheme(AUTO_TERMINAL_THEME_ID, {}, 'light');
    expect(theme.background).toBe('#ffffff');
    expect(ratio(theme.foreground, theme.background)).toBeGreaterThanOrEqual(7);
  });

  it('transparent keeps a see-through background but switches its text palette on light', () => {
    const light = resolveTerminalTheme('transparent', {}, 'light');
    expect(isTransparent(light.background)).toBe(true);
    expect(effectiveTerminalBackground(light, 'light')).toBe('#ffffff');
    expect(ratio(light.foreground, '#ffffff')).toBeGreaterThanOrEqual(7);
    const dark = resolveTerminalTheme('transparent', {}, 'dark');
    expect(ratio(dark.foreground, '#0d1117')).toBeGreaterThanOrEqual(7);
  });

  it('fixed presets ignore the app theme', () => {
    expect(resolveTerminalTheme('dracula', {}, 'light')).toEqual(getThemeById('dracula'));
  });

  it('every preset shows readable text and ANSI colours in both app themes', () => {
    for (const appTheme of ['dark', 'light'] as const) {
      for (const id of [AUTO_TERMINAL_THEME_ID, ...TERMINAL_THEMES.map(p => p.id)]) {
        const shown = displayTerminalTheme(resolveTerminalTheme(id, {}, appTheme), appTheme);
        const bg = effectiveTerminalBackground(shown, appTheme);
        for (const slot of TEXT_SLOTS) {
          expect(ratio(shown[slot], bg), `${id}/${appTheme}/${slot}`).toBeGreaterThanOrEqual(TERMINAL_MIN_CONTRAST - 0.01);
        }
      }
    }
  });

  it('a user override equal to the background still renders readable', () => {
    const raw = resolveTerminalTheme('github-light', { foreground: '#ffffff' }, 'light');
    const shown = displayTerminalTheme(raw, 'light');
    expect(ratio(shown.foreground, shown.background)).toBeGreaterThanOrEqual(TERMINAL_MIN_CONTRAST);
  });
});

describe('app theme subscription', () => {
  it('reports data-theme flips on <html>', async () => {
    const root = document.documentElement;
    root.dataset.theme = 'dark';
    const seen: string[] = [];
    const off = subscribeAppTheme(t => seen.push(t));
    root.dataset.theme = 'light';
    await new Promise(r => setTimeout(r, 0));
    expect(getAppTheme()).toBe('light');
    expect(seen).toEqual(['light']);
    off();
    root.dataset.theme = 'dark';
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toEqual(['light']);
  });
});
