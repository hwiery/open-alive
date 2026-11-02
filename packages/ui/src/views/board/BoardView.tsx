import type { RawMessageSubscribe } from '../../App.tsx';
import { DataView } from '../data/DataView.tsx';

interface BoardViewProps {
  active: boolean;
  subscribeRaw: RawMessageSubscribe;
  focusSessionId?: string | null;
  focusedRunId: string | null;
}

/**
 * The "Cost" view (internal id `board`, kept so saved view state and legacy
 * links still resolve). It used to hold a work tab next to cost; only the cost
 * analytics remain.
 */
export function BoardView({ active }: BoardViewProps) {
  return (
    <div data-testid="cost-view" style={{ height: '100%', width: '100%' }}>
      <DataView active={active} />
    </div>
  );
}
