import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TodoList } from '../views/unified/TodoList.tsx';

const STORAGE_KEY = 'open-alive:todo-float:v1';
const WIDTH = 300;
/** Keep at least this much of the panel on screen so it can always be dragged back. */
const MIN_VISIBLE = 60;
const HEADER_HEIGHT = 56;

interface Position {
  x: number;
  y: number;
}

function loadPosition(): Position {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Position> | null;
    if (raw && typeof raw.x === 'number' && typeof raw.y === 'number') return { x: raw.x, y: raw.y };
  } catch {
    // unreadable storage: default position
  }
  return { x: Math.max(16, window.innerWidth - WIDTH - 24), y: HEADER_HEIGHT + 16 };
}

/** Keep the panel reachable after a drag or a window resize. */
export function clampPosition(pos: Position, viewport: { width: number; height: number }): Position {
  return {
    x: Math.min(Math.max(pos.x, MIN_VISIBLE - WIDTH), viewport.width - MIN_VISIBLE),
    y: Math.min(Math.max(pos.y, HEADER_HEIGHT), viewport.height - MIN_VISIBLE),
  };
}

interface FloatingTodoProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The to-do list as a floating panel above every view (tickets, terminal,
 * cost). Opened from the header; dragged by its title bar; the position is
 * remembered.
 */
export function FloatingTodo({ open, onClose }: FloatingTodoProps) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<Position>(loadPosition);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const onResize = () => setPos((p) => clampPosition(p, { width: window.innerWidth, height: window.innerHeight }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // The close button and other controls in the title bar keep their own clicks.
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setPos(clampPosition(
      { x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setPos((p) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
      } catch {
        // storage disabled: the position just is not remembered
      }
      return p;
    });
  }, []);

  if (!open) return null;

  return (
    <div
      data-testid="floating-todo"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: WIDTH,
        zIndex: 1000,
        borderRadius: 12,
        boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
      }}
    >
      <TodoList
        dragHandleProps={{
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          title: t('todo.dragHint'),
          style: { cursor: 'move', userSelect: 'none', touchAction: 'none' },
          // @ts-expect-error data attributes are fine on a div
          'data-testid': 'floating-todo-handle',
        }}
        headerActions={
          <button
            type="button"
            onClick={onClose}
            aria-label={t('todo.close')}
            title={t('todo.close')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
          >
            ✕
          </button>
        }
      />
    </div>
  );
}
