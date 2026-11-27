import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageLimitsSnapshot } from '@open-alive/core';
import { ModelLogo } from './ModelBadge.tsx';
import {
  formatRemaining, toUsageGroups, usagePillColor, type UsageAccounts, type UsageGroup, type UsagePill,
} from './usagePills.ts';
import { relativeTime } from '../mobile/sessionStatus.ts';

/** A model id per provider, only to pick the right vendor logo. */
const LOGO_MODEL: Record<UsageGroup['provider'], string> = { claude: 'claude', codex: 'gpt' };

/**
 * How much the chips show, most first. The header steps down one level at a
 * time until it stops overflowing: reset countdowns go first, then the
 * model-scoped limits and the Codex age. Percentages always stay.
 */
const DETAIL_FULL = 0;
const DETAIL_NO_RESET = 1;
const DETAIL_MINIMAL = 2;

/** Marks the row the header chips must fit in. */
export const USAGE_FIT_ATTR = 'data-usage-fit';

interface UsageSummaryProps {
  usage: UsageLimitsSnapshot | null;
  now: number;
  /** Clicking a chip opens the cost view. */
  onOpen?: () => void;
  /** `header`: chips in a row, shed detail to fit. `stacked`: one wrapping line per provider (phone). */
  layout?: 'header' | 'stacked';
}

/**
 * Subscription usage, one chip per provider:
 * `[logo] 5H 23% 2h 30m · 7D 41% 3d 04h · FABLE 0% · 3시간 전`.
 * Every number is on the chip — the reset countdown, model-scoped weekly
 * limits, and (for Codex) how old the numbers are — so nothing needs a hover;
 * the tooltip keeps the long-form wording. When the latest fetch failed the
 * chip says so instead of showing old numbers; those stay in the tooltip.
 */
export function UsageSummary({ usage, now, onOpen, layout = 'header' }: UsageSummaryProps) {
  const { t } = useTranslation();
  const stacked = layout === 'stacked';
  const ref = useRef<HTMLDivElement>(null);
  const groups = toUsageGroups(usage, now);
  const detail = useFitDetail(ref, !stacked && groups.length > 0, [usage, now]);
  if (groups.length === 0) return null;
  const showReset = detail < DETAIL_NO_RESET;
  const showExtras = detail < DETAIL_MINIMAL;
  return (
    <div
      ref={ref}
      data-testid="usage-summary"
      data-detail={detail}
      style={{
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'stretch' : 'center',
        gap: stacked ? 4 : 6,
        marginRight: stacked ? 0 : 4,
      }}
    >
      {groups.map((g) => {
        const name = t(`header.usageProvider.${g.provider}`);
        const lines = [
          ...g.windows.map((w) => {
            const remaining = formatRemaining(w.resetsAt, now, w.remainingUnit);
            return `${w.label} ${w.percent}%${remaining ? ` · ${t('header.usageResetsIn', { time: remaining })}` : ''}`;
          }),
          ...g.scoped.map((w) => `${w.label} ${w.percent}%`),
          ...(g.observedAt ? [t('header.usageObservedAt', { time: new Date(g.observedAt).toLocaleString() })] : []),
          ...(g.fetchedAt && g.failed ? [t('header.usageLastFetched', { time: new Date(g.fetchedAt).toLocaleString() })] : []),
        ];
        if (g.failed) lines.unshift(t('header.usageFailed'));
        if (g.accounts) lines.push('', ...accountLines(g.accounts, t));
        const allSpent = Boolean(g.accounts && g.accounts.active === null);
        const age = showExtras && g.observedAt ? relativeTime(now, g.observedAt, t) : '';
        // Compared as displayed: the API's timestamps for the same reset differ by seconds.
        const weekly = g.windows.find((w) => w.label === '7D');
        const weeklyReset = weekly ? formatRemaining(weekly.resetsAt, now, weekly.remainingUnit) : null;
        const segments = [
          ...g.windows.map((w) => ({ pill: w, reset: showReset })),
          ...(showExtras ? g.scoped : []).map((w) => ({
            pill: w,
            reset: showReset && formatRemaining(w.resetsAt, now, w.remainingUnit) !== weeklyReset,
          })),
        ];
        return (
          <div
            key={g.provider}
            data-testid={`usage-${g.provider}`}
            title={`${name}\n${lines.join('\n')}`}
            onClick={onOpen}
            role={onOpen ? 'button' : undefined}
            style={{
              cursor: onOpen ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center',
              flexWrap: stacked ? 'wrap' : 'nowrap',
              columnGap: 6,
              rowGap: 2,
              padding: stacked ? '4px 9px' : '0 9px',
              minHeight: 28,
              borderRadius: 8,
              background: 'var(--surface-2)',
              border: '1px solid var(--border-color)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            <ModelLogo model={LOGO_MODEL[g.provider]} size={13} />
            {g.accounts && (
              <span
                data-testid="usage-claude-account"
                style={{ color: allSpent ? 'var(--accent-red)' : 'var(--text-primary)', fontWeight: 600 }}
              >
                {allSpent ? t('header.usageAllAccountsSpent') : g.accounts.active}
              </span>
            )}
            {g.failed && (
              <span data-testid={`usage-${g.provider}-failed`} style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>
                {t('header.usageFailed')}
              </span>
            )}
            {!g.failed && segments.map(({ pill, reset }, i) => (
              <span key={pill.label} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                {i > 0 && <span>·</span>}
                <WindowSegment pill={pill} now={now} showReset={reset} />
              </span>
            ))}
            {g.accounts && (
              <span
                data-testid="usage-claude-accounts-badge"
                style={{
                  ...muted,
                  padding: '0 5px',
                  borderRadius: 6,
                  border: '1px solid var(--border-color)',
                  fontSize: 10,
                }}
              >
                ⇄{showExtras ? ` ${t('header.usageAccountsBadge', { count: g.accounts.rows.length })}` : g.accounts.rows.length}
              </span>
            )}
            {age && !g.failed && (
              <span data-testid={`usage-${g.provider}-age`} style={muted}>
                · {age}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The most detail that fits the row marked {@link USAGE_FIT_ATTR}.
 *
 * Whenever something that changes widths happens — new numbers, the window or
 * a sibling group resizing (a view switch adds header buttons) — it starts
 * again from full detail and steps down while the row overflows. Both steps
 * run in layout effects, so the oversized attempt is never painted.
 */
function useFitDetail(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean, deps: unknown[]): number {
  const [detail, setDetail] = useState(DETAIL_FULL);
  const [resized, setResized] = useState(0);

  useEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return;
    const row = ref.current?.closest<HTMLElement>(`[${USAGE_FIT_ATTR}]`);
    if (!row) return;
    // The chips mount only once the first numbers land, so this re-runs on `enabled`.
    const observer = new ResizeObserver(() => setResized((n) => n + 1));
    observer.observe(row);
    for (const child of Array.from(row.children)) {
      if (!child.contains(ref.current)) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [enabled, ref]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => setDetail(DETAIL_FULL), [resized, ...deps]);

  useLayoutEffect(() => {
    if (!enabled || detail >= DETAIL_MINIMAL) return;
    const row = ref.current?.closest<HTMLElement>(`[${USAGE_FIT_ATTR}]`);
    if (row && row.scrollWidth > row.clientWidth) setDetail(detail + 1);
  });

  return enabled ? detail : DETAIL_FULL;
}

const muted: CSSProperties = { color: 'var(--text-secondary)', fontWeight: 400 };

/**
 * Tooltip lines for account rotation, one per account:
 * `▸ alt1  5H 12% · 7D 3%` or `  default  7D 99% · paused until Thu 09:00 (7d 99%)`.
 */
function accountLines(accounts: UsageAccounts, t: (key: string, opts?: Record<string, unknown>) => string): string[] {
  return [
    t('header.usageAccountsTitle'),
    ...accounts.rows.map((row) => {
      const numbers = row.windows.length > 0
        ? row.windows.map((w) => `${w.label} ${w.percent}%`).join(' · ')
        : t('header.usageAccountNotRead');
      const paused = row.limitedUntil
        ? ` · ${t('header.usageAccountPaused', {
          time: new Date(row.limitedUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
        })}${row.limitedReason ? ` (${row.limitedReason})` : ''}`
        : '';
      return `${row.active ? '▸' : '  '} ${row.name}  ${numbers}${paused}`;
    }),
  ];
}

/** `5H 23% 2h 30m` — label, percent, and (when room allows) time to reset. */
function WindowSegment({ pill, now, showReset }: { pill: UsagePill; now: number; showReset: boolean }) {
  const remaining = showReset ? formatRemaining(pill.resetsAt, now, pill.remainingUnit) : null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{pill.label}</span>
      <span style={{ color: usagePillColor('var(--text-primary)', pill.ratio), fontWeight: 600 }}>{pill.percent}%</span>
      {remaining && <span style={muted}>{remaining}</span>}
    </span>
  );
}
