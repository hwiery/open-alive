import { useTranslation } from 'react-i18next';
import type { TicketModelMap } from '@open-alive/core';
import { ModelLogo } from '../../components/ModelBadge.tsx';
import type { CodexModelInfo } from '../../hooks/useCodexModels.ts';
import { modelProvider } from '../../services/modelProvider.ts';
import { modelLabel } from './runPresets.ts';

/** Run profile = reasoning effort. Model choice is separate (ModelPicker). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Same closed pattern the server enforces (core `isTicketModelChoice`). */
const CLAUDE_CHOICE = /^(?:claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\[1m\])?|haiku|sonnet|opus|fable)$/;

export function isClaudeChoice(value: string): boolean {
  return value.length <= 80 && CLAUDE_CHOICE.test(value);
}

interface ModelOption {
  id: string;
  label: string;
}

export interface ModelGroups {
  claude: ModelOption[];
  codex: ModelOption[];
  other: ModelOption[];
}

const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'] as const;

/**
 * Only models a local CLI reported — no free-text ids: a model the engines do
 * not know (e.g. one behind an additional API) would fail at run time. Grouped
 * by brand; a model a CLI lists that belongs to neither brand goes to "other".
 */
export function groupModels(models: TicketModelMap, codexModels: readonly CodexModelInfo[]): ModelGroups {
  const groups: ModelGroups = { claude: [], codex: [], other: [] };
  for (const tier of TIER_ORDER) {
    const id = models[tier];
    groups.claude.push({ id, label: modelLabel(id) ?? id });
  }
  for (const m of codexModels) {
    if (!m.listed) continue;
    (modelProvider(m.id) === 'openai' ? groups.codex : groups.other).push({ id: m.id, label: m.label });
  }
  return groups;
}

interface ModelPickerProps {
  models: TicketModelMap;
  codexModels: readonly CodexModelInfo[];
  value: string;
  onChange: (model: string) => void;
}

/** Which model does the work: one row per brand — Claude, Codex, other. */
export function ModelPicker({ models, codexModels, value, onChange }: ModelPickerProps) {
  const { t } = useTranslation();
  const groups = groupModels(models, codexModels);

  const chip = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    fontWeight: active ? 600 : 500,
    padding: '3px 9px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--accent-blue)' : 'var(--border-color)'}`,
    background: active ? 'var(--surface-2)' : 'transparent',
    color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
    cursor: 'pointer',
  });

  const rows: Array<{ key: keyof ModelGroups; options: ModelOption[] }> = [
    { key: 'claude', options: groups.claude },
    { key: 'codex', options: groups.codex },
    { key: 'other', options: groups.other },
  ];

  return (
    <div data-testid="model-picker" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('tickets.model.label')}</span>
      {rows.map(({ key, options }) => (
        <div key={key} data-testid={`model-row-${key}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 52 }}>{t(`tickets.model.group.${key}`)}</span>
          {options.length === 0 ? (
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', opacity: 0.8 }}>{t('tickets.model.none')}</span>
          ) : (
            options.map((m) => {
              const active = value === m.id;
              return (
                <button key={m.id} type="button" aria-pressed={active} title={m.id} style={chip(active)} onClick={() => onChange(m.id)}>
                  <ModelLogo model={m.id} size={12} />
                  {m.label}
                </button>
              );
            })
          )}
        </div>
      ))}
    </div>
  );
}

interface EffortPickerProps {
  value: EffortLevel;
  onChange: (effort: EffortLevel) => void;
  /** Efforts the chosen model accepts; empty = all. */
  supported?: readonly string[];
}

/** The run profile: how hard the chosen model thinks. */
export function EffortPicker({ value, onChange, supported = [] }: EffortPickerProps) {
  const { t } = useTranslation();
  const unsupported = supported.length > 0 && !supported.includes(value);
  return (
    <div data-testid="effort-picker" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 64 }}>{t('tickets.presetLabel')}</span>
      <div style={{ display: 'flex', gap: 4, background: 'var(--bg-tertiary, #21262d)', padding: 3, borderRadius: 10 }}>
        {EFFORT_LEVELS.map((e) => {
          const active = value === e;
          const disabled = supported.length > 0 && !supported.includes(e);
          return (
            <button
              key={e}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              title={`--effort ${e}`}
              onClick={() => onChange(e)}
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                fontWeight: active ? 600 : 500,
                padding: '4px 12px',
                borderRadius: 8,
                border: 'none',
                background: active ? 'var(--bg-secondary)' : 'transparent',
                color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
                opacity: disabled ? 0.4 : 1,
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {e}
            </button>
          );
        })}
      </div>
      {unsupported && <span style={{ fontSize: 11, color: 'var(--accent-orange, #d29922)' }}>{t('tickets.model.effortUnsupported')}</span>}
    </div>
  );
}
