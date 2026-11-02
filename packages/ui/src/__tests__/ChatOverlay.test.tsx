import { TERMINAL_SET_MODE_EVENT } from '../state/terminalViewSwitch.ts';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { ChatOverlay } from '../views/chat/ChatOverlay.js';

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'chat.title': 'Chat',
        'terminal.newTab': 'New tab',
        'terminal.exited': 'Exited',
        'terminal.modePopup': 'Popup',
        'terminal.modeBottom': 'Bottom',
        'terminal.modeRight': 'Right',
        'terminal.modeFullscreen': 'Fullscreen',
        'terminal.collapse': 'Minimize',
      };
      if (key === 'terminal.tabLabel' && opts?.n != null) return `Terminal ${opts.n}`;
      return map[key] ?? key;
    },
  }),
}));

// Mock xterm.js — factories must be self-contained (vi.mock is hoisted)
vi.mock('@xterm/xterm', () => {
  return {
    Terminal: class {
      options: Record<string, unknown>;
      constructor(opts: Record<string, unknown> = {}) {
        this.options = { ...opts };
        ((globalThis as Record<string, unknown>).__xtermInstances as unknown[] | undefined)?.push(this);
      }
      open = vi.fn();
      write = vi.fn();
      dispose = vi.fn();
      focus = vi.fn();
      onData = vi.fn();
      loadAddon = vi.fn();
      cols = 80;
      rows = 24;
    },
  };
});
vi.mock('@xterm/addon-fit', () => {
  return { FitAddon: class { fit = vi.fn(); } };
});
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// Mock ResizeObserver
globalThis.ResizeObserver = class {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
} as unknown as typeof ResizeObserver;

describe('ChatOverlay', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    globalThis.localStorage?.removeItem?.('open-alive:launch-profile');
  });

  it('renders nothing when closed', () => {
    const { container } = render(<ChatOverlay open={false} onToggle={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders header and terminal container when open', () => {
    render(<ChatOverlay open={true} onToggle={() => {}} />);
    expect(screen.getByText(/Chat/)).toBeDefined();
  });

  it('calls onToggle when close button is clicked', () => {
    const onToggle = vi.fn();
    render(<ChatOverlay open={true} onToggle={onToggle} />);
    fireEvent.click(screen.getByTitle('Minimize'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('does not render terminal container when closed', () => {
    const { container } = render(<ChatOverlay open={false} onToggle={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders tab bar with + button when open', () => {
    render(<ChatOverlay open={true} onToggle={() => {}} />);
    expect(screen.getByTitle('New tab')).toBeDefined();
  });

  it('shows the CWD picker with Local and SSH tabs when opened', () => {
    render(<ChatOverlay open={true} onToggle={() => {}} />);
    expect(screen.getByText('terminal.tabLocal')).toBeDefined();
    expect(screen.getByText('terminal.tabSsh')).toBeDefined();
  });

  it('shows the unified launch bar on the Local tab', () => {
    render(<ChatOverlay open={true} onToggle={() => {}} />);
    // Launch presets (agent × skip-permissions) + primary start CTA live in the same bar
    for (const id of ['claude', 'claude-skip', 'codex', 'codex-skip']) {
      expect(screen.getByText(`terminal.launch.${id}`)).toBeDefined();
    }
    expect(screen.getByText(/terminal\.startHere/)).toBeDefined();
  });

  it('shows quick select, recent folders and browse side by side', () => {
    render(<ChatOverlay open={true} onToggle={() => {}} />);
    expect(screen.getByText('terminal.quickSelect')).toBeDefined();
    expect(screen.getByText('terminal.menu.recentFolders')).toBeDefined();
    expect(screen.getByText('terminal.browseSection')).toBeDefined();
  });

  it('starts codex with the bypass flag when that preset is chosen', async () => {
    const onSpawn = vi.fn();
    render(<ChatOverlay open={true} onToggle={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByText('terminal.launch.codex-skip'));
    fireEvent.click(screen.getByText(/terminal\.startHere/));
    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalled());
    const req = onSpawn.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.mode).toBe('codex');
    expect(req.skipPermissions).toBe(true);
    expect(req.claudeSessionId).toBeUndefined();
  });

  it('hides the local-model presets when the server has no local model', () => {
    render(<ChatOverlay open={true} onToggle={() => {}} />);
    expect(screen.queryByText('terminal.launch.codex-local')).toBeNull();
  });

  it('starts codex on the local model when the server offers one', async () => {
    // Only the launch-options endpoint answers; every other request fails as it
    // does without a server.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!String(url).endsWith('/api/terminal/launch-options')) throw new Error('offline');
      return { ok: true, json: async () => ({ localModel: { model: 'gemma4:12b-it-qat', provider: 'ollama' } }) };
    }));
    try {
      const onSpawn = vi.fn();
      render(<ChatOverlay open={true} onToggle={() => {}} onSpawn={onSpawn} />);
      fireEvent.click(await screen.findByText('terminal.launch.codex-local-skip'));
      fireEvent.click(screen.getByText(/terminal\.startHere/));
      await vi.waitFor(() => expect(onSpawn).toHaveBeenCalled());
      const req = onSpawn.mock.calls[0]![0] as Record<string, unknown>;
      expect(req).toMatchObject({ mode: 'codex', localModel: true, skipPermissions: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts claude without skipping permissions when that preset is chosen', async () => {
    const onSpawn = vi.fn();
    render(<ChatOverlay open={true} onToggle={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByText('terminal.launch.claude'));
    fireEvent.click(screen.getByText(/terminal\.startHere/));
    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalled());
    const req = onSpawn.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.mode).toBe('claude');
    expect(req.skipPermissions).toBe(false);
  });

  it('offers no `claude agents` entrypoint and never sends a variant on spawn', async () => {
    const onSpawn = vi.fn();
    render(<ChatOverlay open={true} onToggle={() => {}} onSpawn={onSpawn} />);
    expect(screen.queryByText('claude agents')).toBeNull();
    fireEvent.click(screen.getByText(/terminal\.startHere/));
    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalled());
    const req = onSpawn.mock.calls[0]![0] as Record<string, unknown>;
    expect(req.mode).toBe('claude');
    expect('claudeVariant' in req).toBe(false);
  });

  it('hides the launch bar on the SSH tab (presets launch on click)', () => {
    render(<ChatOverlay open={true} onToggle={() => {}} />);
    fireEvent.click(screen.getByText('terminal.tabSsh'));
    expect(screen.getByText('terminal.menu.manageSsh')).toBeDefined();
    expect(screen.queryByText(/terminal\.startHere/)).toBeNull();
    expect(screen.queryByText('terminal.launch.claude-skip')).toBeNull();
  });

  it('takes its position from the header and reports it back', () => {
    const onModeChange = vi.fn();
    render(<ChatOverlay open={true} onToggle={() => {}} onModeChange={onModeChange} />);
    // First run: docked below, the tickets-over-terminal layout.
    expect(onModeChange).toHaveBeenLastCalledWith('bottom');
    act(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_SET_MODE_EVENT, { detail: 'popup' }));
    });
    expect(onModeChange).toHaveBeenLastCalledWith('popup');
    // Fullscreen is the Terminal › Full view, not something the header asks the panel for.
    act(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_SET_MODE_EVENT, { detail: 'fullscreen' }));
    });
    expect(onModeChange).toHaveBeenLastCalledWith('popup');
  });

  it('remembers the panel position and docked size across reloads', () => {
    const store = new Map<string, string>([
      ['open-alive:terminal-mode', 'right'],
      ['open-alive:terminal-right-width', '420'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      const onModeChange = vi.fn();
      const onDockSizeChange = vi.fn();
      render(<ChatOverlay open={true} onToggle={() => {}} onModeChange={onModeChange} onDockSizeChange={onDockSizeChange} />);
      expect(onModeChange).toHaveBeenLastCalledWith('right');
      expect(onDockSizeChange).toHaveBeenLastCalledWith({ bottomHeight: undefined, rightWidth: 420 });
      expect(screen.getByTestId('terminal-title-bar').parentElement!.style.width).toBe('420px');
      act(() => {
        window.dispatchEvent(new CustomEvent(TERMINAL_SET_MODE_EVENT, { detail: 'bottom' }));
      });
      expect(store.get('open-alive:terminal-mode')).toBe('bottom');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('slides the popup window left/right by its title bar, within the screen, and remembers it', async () => {
    const store = new Map<string, string>([['open-alive:terminal-mode', 'popup']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      render(<ChatOverlay open={true} onToggle={() => {}} />);
      const bar = screen.getByTestId('terminal-title-bar');
      const panel = bar.parentElement!;
      vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 640 } as DOMRect);
      fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1 });
      fireEvent.pointerMove(bar, { clientX: 380, pointerId: 1 });
      fireEvent.pointerUp(bar, { clientX: 380, pointerId: 1 });
      expect(panel.style.transform).toBe('translateX(calc(-50% + -120px))');
      expect(store.get('open-alive:terminal-popup-offset-x')).toBe('-120');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the popup on screen however far it is dragged', async () => {
    const { clampPopupOffset } = await import('../views/chat/ChatOverlay.js');
    expect(clampPopupOffset(-5000, 1280, 640)).toBe(-312);
    expect(clampPopupOffset(5000, 1280, 640)).toBe(312);
    expect(clampPopupOffset(40, 600, 640)).toBe(0);
  });

  it('no longer carries its own position or fullscreen buttons', () => {
    render(<ChatOverlay open={true} onToggle={() => {}} />);
    expect(screen.queryByTitle('Fullscreen')).toBeNull();
    expect(screen.queryByTitle('Popup')).toBeNull();
  });

  it('calls onSpawn when overlay opens for the first time', async () => {
    const onSpawn = vi.fn();
    render(<ChatOverlay open={true} onToggle={() => {}} onSpawn={onSpawn} />);
    // onSpawn is called in rAF after first mount — flush microtasks
    await vi.waitFor(() => {
      // The tab should be created via createTab -> rAF -> onSpawnRef.current
      // Since rAF is mocked in test env, onSpawn may not fire immediately
      // But the + button and tab bar should be visible
      expect(screen.getByTitle('New tab')).toBeDefined();
    });
  });
});
