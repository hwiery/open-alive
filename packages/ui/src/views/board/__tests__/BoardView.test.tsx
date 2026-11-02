import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { BoardView } from '../BoardView';

vi.mock('../../data/DataView.tsx', () => ({
  DataView: ({ active }: { active: boolean }) => <div data-testid="data-view" data-active={String(active)} />,
}));

const noopSub = () => () => {};

afterEach(cleanup);

describe('BoardView (Cost)', () => {
  it('shows only the cost analytics, with no work tab', () => {
    render(<BoardView active subscribeRaw={noopSub} focusedRunId={null} />);
    expect(screen.getByTestId('data-view')).toHaveAttribute('data-active', 'true');
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('passes inactivity through so the cost view stops polling', () => {
    render(<BoardView active={false} subscribeRaw={noopSub} focusedRunId={null} />);
    expect(screen.getByTestId('data-view')).toHaveAttribute('data-active', 'false');
  });
});
