import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MobileTerminal } from '../MobileTerminal.tsx';
import { createTermFeed } from '../termFeed.ts';

// jsdom has no canvas for xterm's renderer; a fake records what reached it.
const xterm = vi.hoisted(() => ({
  instances: [] as Array<{ writes: string[]; scrolled: number[]; cols: number; rows: number; options: Record<string, unknown> }>,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    writes: string[] = [];
    scrolled: number[] = [];
    buffer = { active: { viewportY: 100, baseY: 100 } };
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    constructor(opts: { cols: number; rows: number }) {
      this.options = { ...opts };
      this.cols = opts.cols;
      this.rows = opts.rows;
      xterm.instances.push(this);
    }
    open(host: HTMLElement) {
      const el = document.createElement('div');
      el.className = 'xterm';
      el.setAttribute('data-testid', 'xterm-screen');
      host.appendChild(el);
    }
    scrollLines(n: number) { this.scrolled.push(n); }
    write(data: string) { this.writes.push(data); }
    reset() {}
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
    dispose() {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  xterm.instances.length = 0;
});

const props = (over = {}) => ({
  title: 'app',
  subtitle: 'my-repo',
  feed: createTermFeed(),
  hasOutput: false,
  canType: true,
  exited: false,
  onBack: vi.fn(),
  onSend: vi.fn(),
  onKey: vi.fn(),
  ...over,
});

describe('MobileTerminal', () => {
  it('goes back from an icon and names the checkout under the title', () => {
    const onBack = vi.fn();
    render(<MobileTerminal {...props({ onBack })} />);
    const back = screen.getByRole('button', { name: /뒤로|Back/ });
    expect(back).toHaveTextContent('‹');
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByText('my-repo')).toBeInTheDocument();
  });

  it('hands raw pty bytes to the emulator untouched, including cursor moves', () => {
    const feed = createTermFeed();
    // Sent before mount: the feed holds it until the terminal is listening.
    feed.push({ kind: 'data', data: '\x1b[2K\x1b[1AThinking' });
    render(<MobileTerminal {...props({ feed, hasOutput: true })} />);
    feed.push({ kind: 'data', data: '\x1b[5GDone' });
    expect(xterm.instances[0]!.writes).toEqual(['\x1b[2K\x1b[1AThinking', '\x1b[5GDone']);
  });

  it('lays out at the pty grid the server reports, not the phone width', () => {
    const feed = createTermFeed();
    render(<MobileTerminal {...props({ feed })} />);
    feed.push({ kind: 'size', cols: 120, rows: 40 });
    expect(xterm.instances[0]).toMatchObject({ cols: 120, rows: 40 });
  });

  it('says it is connecting until the first output arrives', () => {
    const { rerender } = render(<MobileTerminal {...props()} />);
    expect(screen.getByText(/연결 중|Attaching/)).toBeInTheDocument();
    rerender(<MobileTerminal {...props({ hasOutput: true })} />);
    expect(screen.queryByText(/연결 중|Attaching/)).not.toBeInTheDocument();
  });

  it('sends a typed line and clears the box', () => {
    const onSend = vi.fn();
    render(<MobileTerminal {...props({ onSend })} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'git status' } });
    fireEvent.click(screen.getByRole('button', { name: /전송|Send/i }));
    // A shell acts on the carriage return, not on the characters.
    expect(onSend).toHaveBeenCalledWith('git status\r');
    expect(box).toHaveValue('');
  });

  it('does not send an empty line by accident', () => {
    const onSend = vi.fn();
    render(<MobileTerminal {...props({ onSend })} />);
    fireEvent.click(screen.getByRole('button', { name: /전송|Send/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('offers the keys a phone keyboard cannot produce', () => {
    const onKey = vi.fn();
    render(<MobileTerminal {...props({ onKey })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl-C' }));
    expect(onKey).toHaveBeenCalledWith('\x03');
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    expect(onKey).toHaveBeenCalledWith('\x1b');
    fireEvent.click(screen.getByRole('button', { name: '↑' }));
    expect(onKey).toHaveBeenCalledWith('\x1b[A');
    // Cursor moves inside a prompt's line, and end-of-input for a REPL.
    fireEvent.click(screen.getByRole('button', { name: '←' }));
    expect(onKey).toHaveBeenCalledWith('\x1b[D');
    fireEvent.click(screen.getByRole('button', { name: '→' }));
    expect(onKey).toHaveBeenCalledWith('\x1b[C');
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl-D' }));
    expect(onKey).toHaveBeenCalledWith('\x04');
  });

  it('zooms the pane to a readable font and remembers it', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      render(<MobileTerminal {...props()} />);
      const zoom = screen.getByRole('button', { name: /확대|Zoom/ });
      expect(zoom).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(zoom);
      expect(zoom).toHaveAttribute('aria-pressed', 'true');
      expect(store.get('open-alive:mobile-terminal-zoom')).toBe('1');
      cleanup();
      render(<MobileTerminal {...props()} />);
      expect(screen.getByRole('button', { name: /확대|Zoom/ })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hides every input control when typing is not permitted', () => {
    render(<MobileTerminal {...props({ canType: false })} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ctrl-C' })).not.toBeInTheDocument();
    expect(screen.getByText(/읽기 전용|Read-only/i)).toBeInTheDocument();
  });

  it('leaves a downward swipe to the terminal scroll, and re-attaches from a button', () => {
    const onRefresh = vi.fn();
    render(<MobileTerminal {...props({ onRefresh })} />);
    // Pull-to-refresh here cleared the output mid-read and fought the xterm scroll.
    expect(screen.queryByTestId('pull-scroll')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /다시 연결|Reattach/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('scrolls history from a swipe on the terminal itself, not only on the blank pane', () => {
    // 24 rows at 240px: one line per 10px of travel.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 240 } as DOMRect);
    render(<MobileTerminal {...props()} />);
    const target = screen.getByTestId('xterm-screen');
    fireEvent.touchStart(target, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(target, { touches: [{ clientY: 250 }] });
    expect(xterm.instances[0]?.scrolled).toEqual([-5]);
  });

  it('says when the terminal has exited instead of looking merely idle', () => {
    render(<MobileTerminal {...props({ exited: true })} />);
    expect(screen.getByText(/종료되었습니다|has exited/i)).toBeInTheDocument();
  });
});
