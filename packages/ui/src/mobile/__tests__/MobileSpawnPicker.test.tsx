import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { MobileSpawnPicker } from '../MobileSpawnPicker.tsx';

afterEach(cleanup);
// jsdom here ships no working localStorage; a Map-backed one per test.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
});
afterEach(() => vi.unstubAllGlobals());

const projects = [
  { path: '/Users/me/work/app', name: 'app' },
  { path: '/Users/me/work/site', name: 'site' },
];

describe('MobileSpawnPicker', () => {
  it('starts Claude in the tapped folder, skip-permissions off until opted in (and then remembered)', () => {
    const onSpawn = vi.fn();
    const { unmount } = render(<MobileSpawnPicker projects={projects} onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByRole('button', { name: 'site' }));
    expect(onSpawn).toHaveBeenLastCalledWith({ cwd: '/Users/me/work/site', mode: 'claude', skipPermissions: false });
    fireEvent.click(screen.getByRole('checkbox'));
    unmount();
    render(<MobileSpawnPicker projects={projects} onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByRole('button', { name: 'site' }));
    expect(onSpawn).toHaveBeenLastCalledWith({ cwd: '/Users/me/work/site', mode: 'claude', skipPermissions: true });
  });

  it('remembers a shell choice and never sends skip-permissions for it', () => {
    const onSpawn = vi.fn();
    const { unmount } = render(<MobileSpawnPicker projects={projects} onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByRole('radio', { name: /셸|Shell/ }));
    unmount();
    render(<MobileSpawnPicker projects={projects} onCancel={() => {}} onSpawn={onSpawn} />);
    expect(screen.getByRole('radio', { name: /셸|Shell/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'app' }));
    expect(onSpawn).toHaveBeenCalledWith({ cwd: '/Users/me/work/app', mode: 'shell', skipPermissions: false });
  });

  it('starts Codex, with the skip switch carrying over', () => {
    const onSpawn = vi.fn();
    render(<MobileSpawnPicker projects={projects} onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByRole('radio', { name: /^Codex$/ }));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(/승인·샌드박스|without approval or sandbox/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'app' }));
    expect(onSpawn).toHaveBeenLastCalledWith({ cwd: '/Users/me/work/app', mode: 'codex', skipPermissions: true });
  });

  it('offers Codex on the local model only when the server has one', () => {
    const onSpawn = vi.fn();
    const { unmount } = render(<MobileSpawnPicker projects={projects} onCancel={() => {}} onSpawn={onSpawn} />);
    expect(screen.queryByRole('radio', { name: /로컬|local/i })).not.toBeInTheDocument();
    unmount();
    render(<MobileSpawnPicker projects={projects} localModel="gemma4:12b-it-qat" onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByRole('radio', { name: /로컬|local/i }));
    expect(screen.getByText(/gemma4:12b-it-qat/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'site' }));
    expect(onSpawn).toHaveBeenLastCalledWith({ cwd: '/Users/me/work/site', mode: 'codex-local', skipPermissions: false });
  });

  it('falls back to Claude when a remembered local choice is no longer offered', () => {
    const onSpawn = vi.fn();
    const { unmount } = render(<MobileSpawnPicker projects={projects} localModel="gemma4" onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByRole('radio', { name: /로컬|local/i }));
    unmount();
    render(<MobileSpawnPicker projects={projects} onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.click(screen.getByRole('button', { name: 'app' }));
    expect(onSpawn).toHaveBeenLastCalledWith({ cwd: '/Users/me/work/app', mode: 'claude', skipPermissions: false });
  });

  it('lists running, then recent, then allowed folders, each folder once', () => {
    render(
      <MobileSpawnPicker
        running={[{ path: '/w/live', name: 'live' }]}
        recent={[{ path: '/w/live', name: 'live' }, { path: '/w/old', name: 'old' }]}
        projects={[{ path: '/w/old', name: 'old' }, { path: '/w/new', name: 'new' }]}
        onCancel={() => {}}
        onSpawn={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button', { name: /^(live|old|new)$/ }).map((b) => b.getAttribute('aria-label')))
      .toEqual(['live', 'old', 'new']);
    expect(screen.getByText(/지금 실행 중인 폴더|Running now/)).toBeInTheDocument();
  });

  it('starts in a typed path', () => {
    const onSpawn = vi.fn();
    render(<MobileSpawnPicker projects={[]} onCancel={() => {}} onSpawn={onSpawn} />);
    fireEvent.change(screen.getByRole('textbox', { name: /경로|path/i }), { target: { value: ' /tmp/x ' } });
    fireEvent.click(screen.getByRole('button', { name: /^(시작|Start)$/ }));
    expect(onSpawn).toHaveBeenCalledWith({ cwd: '/tmp/x', mode: 'claude', skipPermissions: false });
  });

  it('cancels back', () => {
    const onCancel = vi.fn();
    render(<MobileSpawnPicker projects={projects} onCancel={onCancel} onSpawn={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /뒤로|Back/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('explains when there is no folder to offer', () => {
    render(<MobileSpawnPicker projects={[]} onCancel={() => {}} onSpawn={vi.fn()} />);
    expect(screen.getByText(/OPEN_ALIVE_TICKET_ROOTS/)).toBeInTheDocument();
  });
});
