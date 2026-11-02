import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MobileSessionList, type MobileSession } from '../MobileSessionList.tsx';

afterEach(cleanup);

const session = (over: Partial<MobileSession>): MobileSession => ({
  sessionId: 's1', providerSessionId: 'p1', displayName: '로그인 리팩터링', state: 'ready',
  cwd: '/Users/me/work/app', lastActivityAt: 1000, needsApproval: false, ...over,
});

describe('MobileSessionList', () => {
  it('lists sessions with their project and state', () => {
    render(<MobileSessionList sessions={[session({})]} onOpen={() => {}} loading={false} />);
    expect(screen.getByText('로그인 리팩터링')).toBeInTheDocument();
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  it('orders running sessions by recency', () => {
    render(
      <MobileSessionList
        sessions={[
          session({ sessionId: 'a', displayName: '오래된 것', state: 'using-tool', lastActivityAt: 1 }),
          session({ sessionId: 'b', displayName: '방금 것', state: 'ready', lastActivityAt: 9_000_000 }),
        ]}
        onOpen={() => {}}
        loading={false}
      />,
    );
    expect(screen.getAllByRole('button', { name: /것/ })[0]).toHaveTextContent('방금 것');
  });

  it('follows the PC: a catalog "starting" the PC no longer runs is folded under ended', () => {
    render(
      <MobileSessionList
        sessions={[
          session({ sessionId: 'a', providerSessionId: 'pa', displayName: '유령 세션', state: 'starting', lastActivityAt: 9_000_000 }),
          session({ sessionId: 'b', providerSessionId: 'pb', displayName: 'PC에서 도는 것', state: 'stopped', lastActivityAt: 1 }),
        ]}
        live={new Map([['pb', 'active']])}
        onOpen={() => {}}
        loading={false}
      />,
    );
    expect(screen.getByText('PC에서 도는 것')).toBeInTheDocument();
    expect(screen.getByText(/작업 중|Working/)).toBeInTheDocument();
    expect(screen.queryByText('유령 세션')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /종료된 세션 1|Ended sessions 1/ }));
    expect(screen.getByText('유령 세션')).toBeInTheDocument();
  });

  it('leads each card with state and last activity', () => {
    const now = 10 * 60_000;
    render(<MobileSessionList sessions={[session({ lastActivityAt: now - 5 * 60_000 })]} now={now} onOpen={() => {}} loading={false} />);
    expect(screen.getByText(/대기 중|Idle/)).toBeInTheDocument();
    expect(screen.getByText(/5분 전|5m ago/)).toBeInTheDocument();
  });

  it('lifts a recently blocked session above more recent chatter', () => {
    const now = 9_000_000;
    render(
      <MobileSessionList
        sessions={[
          session({ sessionId: 'a', displayName: '방금 움직인 것', state: 'using-tool', lastActivityAt: now }),
          session({ sessionId: 'b', displayName: '승인 기다리는 것', state: 'ready', needsApproval: true, lastActivityAt: now - 600_000 }),
        ]}
        onOpen={() => {}}
        loading={false}
      />,
    );
    expect(screen.getAllByRole('button', { name: /것/ })[0]).toHaveTextContent('승인 기다리는 것');
  });

  it('does not lift a session that has been blocked since last month', () => {
    const now = 9_000_000;
    render(
      <MobileSessionList
        sessions={[
          session({ sessionId: 'a', displayName: '방금 것', state: 'using-tool', lastActivityAt: now }),
          session({ sessionId: 'b', displayName: '오래 멈춘 것', state: 'waiting-user', lastActivityAt: now - 30 * 86_400_000 }),
        ]}
        onOpen={() => {}}
        loading={false}
      />,
    );
    expect(screen.getAllByRole('button', { name: /것/ })[0]).toHaveTextContent('방금 것');
  });

  it('opens a session when tapped', () => {
    const onOpen = vi.fn();
    render(<MobileSessionList sessions={[session({})]} onOpen={onOpen} loading={false} />);
    fireEvent.click(screen.getByRole('button', { name: /로그인 리팩터링/ }));
    expect(onOpen).toHaveBeenCalledWith('s1');
  });

  it('marks a session that is blocked on a human approving a tool call', () => {
    render(<MobileSessionList sessions={[session({ needsApproval: true })]} onOpen={() => {}} loading={false} />);
    expect(screen.getByLabelText(/승인|approval/i)).toBeInTheDocument();
  });

  it('explains an empty list instead of showing nothing', () => {
    render(<MobileSessionList sessions={[]} onOpen={() => {}} loading={false} />);
    expect(screen.getByText(/세션이 없습니다|No sessions/)).toBeInTheDocument();
  });

  it('says the list could not be loaded instead of claiming nothing runs', () => {
    render(<MobileSessionList sessions={[]} onOpen={() => {}} loading={false} error="HTTP 503: canonical event log unavailable" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/canonical event log unavailable/);
    expect(screen.queryByText(/세션이 없습니다|No sessions/)).not.toBeInTheDocument();
  });
});

describe('MobileSessionList — long catalogs', () => {
  it('caps the rows after sorting, so the newest survive the cut', () => {
    // The catalog holds every session this machine has ever run. Slicing before
    // the sort handed the phone an arbitrary slab of history.
    const many = Array.from({ length: 200 }, (_, i) =>
      session({ sessionId: `s${i}`, displayName: `세션 ${i}`, lastActivityAt: i }),
    );
    render(<MobileSessionList sessions={many} onOpen={() => {}} loading={false} />);
    const rows = screen.getAllByRole('button', { name: /세션 / });
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(rows[0]).toHaveTextContent('세션 199');
  });
});

describe('MobileSessionList — no heading', () => {
  it('does not repeat the tab name as a heading', () => {
    // The top-level switch already says "세션"; a second one costs a fifth of
    // the visible rows on a 390px screen.
    render(<MobileSessionList sessions={[session({})]} onOpen={() => {}} loading={false} />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('로그인 리팩터링')).toBeInTheDocument();
  });
});

describe('MobileSessionList — grouped by project root', () => {
  it('groups sessions under their project, the group with the most urgent session first', () => {
    const now = 9_000_000;
    render(
      <MobileSessionList
        sessions={[
          session({ sessionId: 'a', displayName: 'A1', cwd: '/w/alpha', lastActivityAt: now }),
          session({ sessionId: 'b', displayName: 'B1', cwd: '/w/beta', projectName: 'Beta 앱', needsApproval: true, lastActivityAt: now - 60_000 }),
          session({ sessionId: 'c', displayName: 'A2', cwd: '/w/alpha', lastActivityAt: now - 120_000 }),
        ]}
        onOpen={() => {}}
        loading={false}
      />,
    );
    const groups = screen.getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Beta 앱', 'alpha']);
    expect(groups[1]).toHaveTextContent('A1');
    expect(groups[1]).toHaveTextContent('A2');
  });

  it('keeps the list pane pinned to the screen so it scrolls', () => {
    // A `position: relative` override once let the pane grow to its content, so
    // the lower rows could never be scrolled into view.
    render(<MobileSessionList sessions={[session({})]} onOpen={() => {}} loading={false} />);
    const pane = screen.getByTestId('pull-scroll').parentElement!.parentElement!;
    expect(pane.style.position).toBe('absolute');
  });
});
