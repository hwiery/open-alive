import '@open-alive/i18n';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { UsageLimitsSnapshot } from '@open-alive/core';
import { HeaderBar } from '../HeaderBar.tsx';

const usage: UsageLimitsSnapshot = {
  fiveHour: { utilization: 0.09, resetsAt: null },
  sevenDay: { utilization: 0.08, resetsAt: null },
  scopedWeekly: [{ modelName: 'Fable', utilization: 0.0, resetsAt: null }],
  fetchedAt: 0,
  stale: false,
  codex: { fiveHour: null, sevenDay: { utilization: 0.13, resetsAt: null }, observedAt: 1_000 },
};

const renderHeader = (usageLimits: UsageLimitsSnapshot | null) =>
  render(<HeaderBar viewMode="tickets" onViewModeChange={() => {}} usageLimits={usageLimits} />);

// vitest runs without `globals`, so RTL's auto-cleanup never registers.
afterEach(cleanup);

describe('HeaderBar usage', () => {
  it('shows one compact chip each for Claude and Codex', () => {
    renderHeader(usage);
    const claude = screen.getByTestId('usage-claude');
    expect(claude.textContent).toContain('5H9%·7D8%·FABLE0%');
    expect(claude.querySelector('[data-provider="anthropic"]')).not.toBeNull();
    const codex = screen.getByTestId('usage-codex');
    expect(codex.textContent).toContain('7D13%');
    expect(codex.querySelector('[data-provider="openai"]')).not.toBeNull();
  });

  it('shows reset times, model-scoped limits and the Codex age on the chip, no hover needed', () => {
    const now = Date.now() + 5_000;
    renderHeader({ ...usage, fiveHour: { utilization: 0.09, resetsAt: now + 2 * 3600_000 + 30 * 60_000 } });
    const claude = screen.getByTestId('usage-claude');
    expect(claude.textContent).toContain('2h 30m');
    expect(screen.getByText('FABLE')).not.toBeNull();
    // observedAt 1_000 is decades ago: the age reads in days.
    expect(screen.getByTestId('usage-codex-age').textContent).toMatch(/\d/);
    // The tooltip keeps the long-form wording.
    expect(claude.getAttribute('title') ?? '').toContain('FABLE 0%');
  });

  it('says the fetch failed instead of showing last-known numbers', () => {
    renderHeader({ ...usage, fetchedAt: 1_000, stale: true, codex: { ...usage.codex!, stale: true } });
    const claude = screen.getByTestId('usage-claude');
    expect(screen.getByTestId('usage-claude-failed')).not.toBeNull();
    expect(claude.textContent).not.toContain('9%');
    // The last-known values stay readable in the tooltip.
    expect(claude.getAttribute('title') ?? '').toContain('5H 9%');
    expect(screen.getByTestId('usage-codex-failed')).not.toBeNull();
  });

  it('shows the failure even when nothing was ever fetched', () => {
    renderHeader({ fiveHour: null, sevenDay: null, scopedWeekly: [], fetchedAt: 0, stale: true });
    expect(screen.getByTestId('usage-claude-failed')).not.toBeNull();
  });

  it('renders nothing before the first poll lands', () => {
    renderHeader(null);
    expect(screen.queryByTestId('usage-summary')).toBeNull();
  });

  it('sheds reset times, then scoped limits and the Codex age, while the header overflows', () => {
    // jsdom has no layout: report an overflow whenever the chips carry more than percentages.
    const proto = HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'scrollWidth');
    Object.defineProperty(proto, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.hasAttribute('data-usage-fit')) return 0;
        return this.querySelector('[data-testid="usage-summary"]')?.getAttribute('data-detail') === '2' ? 0 : 1;
      },
    });
    try {
      const now = Date.now() + 5_000;
      renderHeader({ ...usage, fiveHour: { utilization: 0.09, resetsAt: now + 2 * 3600_000 } });
      expect(screen.getByTestId('usage-summary').getAttribute('data-detail')).toBe('2');
      expect(screen.getByTestId('usage-claude').textContent).toMatch(/5H9%·7D8%$/);
      expect(screen.queryByTestId('usage-codex-age')).toBeNull();
      // The tooltip still carries everything.
      expect(screen.getByTestId('usage-claude').getAttribute('title') ?? '').toContain('FABLE 0%');
    } finally {
      // jsdom defines scrollWidth on Element, not HTMLElement: with no own
      // descriptor to restore, remove the override or it leaks into later tests.
      if (original) Object.defineProperty(proto, 'scrollWidth', original);
      else delete (proto as { scrollWidth?: number }).scrollWidth;
    }
  });

  describe('Claude account rotation', () => {
    const now = Date.now();
    const rotating = (active: string | null): UsageLimitsSnapshot => ({
      ...usage,
      codex: null,
      claudeAccounts: {
        active,
        threshold: 0.99,
        accounts: [
          {
            name: 'default',
            fiveHour: null,
            sevenDay: { utilization: 0.99, resetsAt: now + 86_400_000 },
            scopedWeekly: [],
            fetchedAt: 1,
            limitedUntil: now + 86_400_000,
            limitedReason: '7d 99%',
          },
          { name: 'alt1', fiveHour: { utilization: 0.12, resetsAt: null }, sevenDay: { utilization: 0.03, resetsAt: null }, scopedWeekly: [], fetchedAt: 1 },
        ],
      },
    });

    it('shows every account on the chip, the active one marked, a paused one flagged', () => {
      renderHeader(rotating('alt1'));
      const alt1 = screen.getByTestId('usage-account-alt1');
      const def = screen.getByTestId('usage-account-default');
      expect(alt1.getAttribute('data-active')).toBe('true');
      expect(def.getAttribute('data-active')).toBeNull();
      expect(alt1.textContent).toContain('5H12%');
      expect(alt1.textContent).toContain('7D3%');
      expect(def.textContent).toContain('⏸ default');
      expect(def.textContent).toContain('7D99%');
      // Accounts are listed in configured order.
      const chip = screen.getByTestId('usage-claude');
      expect(chip.textContent!.indexOf('default')).toBeLessThan(chip.textContent!.indexOf('alt1'));
    });

    it('lists every account in the tooltip, marking the active one and the paused one', () => {
      renderHeader(rotating('alt1'));
      const title = screen.getByTestId('usage-claude').getAttribute('title') ?? '';
      expect(title).toMatch(/▸ alt1 {2}5H 12% · 7D 3%/);
      expect(title).toMatch(/ {2}default {2}7D 99% · .*\(7d 99%\)/);
    });

    it('keeps one number per account when the header is tight', () => {
      const proto = HTMLElement.prototype;
      Object.defineProperty(proto, 'scrollWidth', {
        configurable: true,
        get(this: HTMLElement) {
          if (!this.hasAttribute('data-usage-fit')) return 0;
          return this.querySelector('[data-testid="usage-summary"]')?.getAttribute('data-detail') === '2' ? 0 : 1;
        },
      });
      try {
        renderHeader(rotating('alt1'));
        expect(screen.getByTestId('usage-account-alt1').textContent).toBe('alt17D3%');
        expect(screen.getByTestId('usage-account-default').textContent).toBe('⏸ default7D99%');
      } finally {
        delete (proto as { scrollWidth?: number }).scrollWidth;
      }
    });

    it('says every account is spent when none is active, still listing them', () => {
      renderHeader(rotating(null));
      expect(screen.getByTestId('usage-claude-all-spent')).not.toBeNull();
      expect(screen.getByTestId('usage-account-alt1').getAttribute('data-active')).toBeNull();
    });

    it('shows no account parts without rotation', () => {
      renderHeader(usage);
      expect(screen.queryByTestId('usage-account-default')).toBeNull();
      expect(screen.queryByTestId('usage-claude-all-spent')).toBeNull();
    });
  });
});
