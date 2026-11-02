import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FloatingTodo, clampPosition } from '../components/FloatingTodo.tsx';

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FloatingTodo', () => {
  it('moves when its title bar is dragged and remembers where it was left', () => {
    store.set('open-alive:todo-float:v1', JSON.stringify({ x: 100, y: 100 }));
    render(<FloatingTodo open onClose={() => {}} />);
    const panel = screen.getByTestId('floating-todo');
    const handle = screen.getByTestId('floating-todo-handle');
    expect(panel.style.left).toBe('100px');
    fireEvent.pointerDown(handle, { clientX: 110, clientY: 110, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 210, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 210, clientY: 160, pointerId: 1 });
    expect(panel.style.left).toBe('200px');
    expect(panel.style.top).toBe('150px');
    expect(JSON.parse(store.get('open-alive:todo-float:v1')!)).toEqual({ x: 200, y: 150 });
  });

  it('does not start a drag from the close button', () => {
    const onClose = vi.fn();
    render(<FloatingTodo open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close to-do|할 일 닫기/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps part of the panel on screen, below the header', () => {
    expect(clampPosition({ x: -9999, y: -50 }, { width: 1200, height: 800 })).toEqual({ x: -240, y: 56 });
    expect(clampPosition({ x: 5000, y: 5000 }, { width: 1200, height: 800 })).toEqual({ x: 1140, y: 740 });
  });

  it('renders nothing while closed', () => {
    render(<FloatingTodo open={false} onClose={() => {}} />);
    expect(screen.queryByTestId('floating-todo')).toBeNull();
  });
});
