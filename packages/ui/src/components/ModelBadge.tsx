import { useTranslation } from 'react-i18next';
import {
  siClaude,
  siGooglegemini,
  siMeta,
  siMistralai,
  siDeepseek,
  siQwen,
  siKimi,
  type SimpleIcon,
} from 'simple-icons';
import { modelProvider, type ModelProvider } from '../services/modelProvider.ts';
import { OPENAI_ICON, XAI_ICON, ZHIPU_ICON, type BrandIcon } from './brandIcons.ts';
import { modelLabel } from '../views/tickets/runPresets.ts';

/**
 * Logos come from Simple Icons (CC0), plus OpenAI / xAI / Zhipu from lobe-icons
 * (MIT). An unknown provider gets a neutral dot.
 * Brand colours are fixed by the brand, not the theme; the dark-brand ones use
 * the current text colour so they stay visible in both themes.
 */
const ICONS: Partial<Record<ModelProvider, SimpleIcon>> = {
  anthropic: siClaude,
  google: siGooglegemini,
  meta: siMeta,
  mistral: siMistralai,
  deepseek: siDeepseek,
  qwen: siQwen,
  moonshot: siKimi,
};

/** Brands not in Simple Icons, drawn from lobe-icons paths (see brandIcons.ts). */
const EXTRA_ICONS: Partial<Record<ModelProvider, BrandIcon>> = {
  openai: OPENAI_ICON,
  xai: XAI_ICON,
  zhipu: ZHIPU_ICON,
};

/** Brands whose official colour is black/near-black: draw them in the text colour. */
const MONOCHROME: ReadonlySet<ModelProvider> = new Set(['moonshot', 'openai', 'xai', 'zhipu']);

interface ModelLogoProps {
  model: string | undefined | null;
  size?: number;
}

/** Just the company mark for a model id. */
export function ModelLogo({ model, size = 14 }: ModelLogoProps) {
  const { t } = useTranslation();
  const provider = modelProvider(model);
  const name = t(`models.provider.${provider}`);
  const icon = ICONS[provider];
  const extra = EXTRA_ICONS[provider];
  const color = MONOCHROME.has(provider) ? 'var(--text-primary)' : icon ? `#${icon.hex}` : 'var(--text-secondary)';
  if (extra) {
    return (
      <svg role="img" aria-label={name} data-provider={provider} width={size} height={size} viewBox="0 0 24 24" fill={color} fillRule={extra.fillRule} style={{ flexShrink: 0 }}>
        <title>{name}</title>
        <path d={extra.path} />
      </svg>
    );
  }
  if (icon) {
    return (
      <svg
        role="img"
        aria-label={name}
        data-provider={provider}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={color}
        style={{ flexShrink: 0 }}
      >
        <title>{name}</title>
        <path d={icon.path} />
      </svg>
    );
  }
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      data-provider={provider}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        border: '1px solid var(--border-color)',
        color,
        fontSize: Math.max(7, Math.round(size * 0.5)),
        fontWeight: 700,
        lineHeight: 1,
        fontFamily: 'var(--font-ui)',
      }}
    >
      •
    </span>
  );
}

interface ModelBadgeProps extends ModelLogoProps {
  /** Show the raw id instead of the display name. */
  raw?: boolean;
  /** Prefix such as "진행 중" rendered before the logo. */
  prefix?: string;
}

/** Logo + model name: which company's model is doing this work. */
export function ModelBadge({ model, size = 14, raw = false, prefix }: ModelBadgeProps) {
  if (!model) return null;
  const label = raw ? model : (modelLabel(model) ?? model);
  return (
    <span
      data-testid="model-badge"
      title={model}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%' }}
    >
      {prefix && <span style={{ opacity: 0.75 }}>{prefix}</span>}
      <ModelLogo model={model} size={size} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  );
}
