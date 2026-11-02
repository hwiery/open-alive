import '@testing-library/jest-dom/vitest';
import '@open-alive/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ModelPicker, EffortPicker, groupModels, type EffortLevel } from '../views/tickets/ModelPicker.tsx';
import { ModelBadge } from '../components/ModelBadge.tsx';

const models = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
const codex = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], listed: true },
  { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], listed: false },
];

function Harness({ onModel }: { onModel: (m: string) => void }) {
  const [model, setModel] = useState('claude-opus-5-5');
  return (
    <ModelPicker
      models={models}
      codexModels={codex}
      value={model}
      onChange={(m) => {
        setModel(m);
        onModel(m);
      }}
    />
  );
}

afterEach(cleanup);

describe('ModelPicker', () => {
  it('offers the probed Claude tiers and listed Codex models, each with its logo', () => {
    render(<Harness onModel={() => {}} />);
    expect(screen.getByRole('button', { name: /Opus 5\.5/ })).toHaveAttribute('aria-pressed', 'true');
    const terra = screen.getByRole('button', { name: /GPT-5\.6-Terra/ });
    expect(terra.querySelector('[data-provider="openai"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /GPT-5\.5$/ })).toBeNull(); // hidden models: custom field only
  });

  it('switches the model without touching the effort', () => {
    const onModel = vi.fn();
    render(<Harness onModel={onModel} />);
    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.6-Terra/ }));
    expect(onModel).toHaveBeenLastCalledWith('gpt-5.6-terra');
    fireEvent.click(screen.getByRole('button', { name: /Haiku 5\.5/ }));
    expect(onModel).toHaveBeenLastCalledWith('claude-haiku-5-5');
  });

  it('shows one row per brand and only detected models — no free-text field', () => {
    render(<Harness onModel={() => {}} />);
    expect(screen.getByTestId('model-row-claude')).toHaveTextContent(/Haiku 5\.5.*Sonnet 5\.5.*Opus 5\.5.*Fable 5\.1/);
    expect(screen.getByTestId('model-row-codex')).toHaveTextContent('GPT-5.6-Terra');
    expect(screen.getByTestId('model-row-other')).toHaveTextContent(/식별된 모델 없음|No models detected/);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('groupModels', () => {
  it('puts a CLI-listed model of another brand under other', () => {
    const groups = groupModels(models, [
      ...codex,
      { id: 'llama4-scout', label: 'Llama 4 Scout', efforts: [], listed: true },
    ]);
    expect(groups.codex.map((m) => m.id)).toEqual(['gpt-5.6-terra']);
    expect(groups.other.map((m) => m.id)).toEqual(['llama4-scout']);
  });
});

describe('EffortPicker', () => {
  it('is the run profile: the five effort values, no translated labels', () => {
    const onChange = vi.fn();
    function H() {
      const [e, setE] = useState<EffortLevel>('high');
      return <EffortPicker value={e} onChange={(v) => { setE(v); onChange(v); }} />;
    }
    render(<H />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    fireEvent.click(screen.getByRole('button', { name: 'max' }));
    expect(onChange).toHaveBeenLastCalledWith('max');
  });

  it('disables efforts the chosen Codex model does not accept', () => {
    render(<EffortPicker value="max" onChange={() => {}} supported={['low', 'medium', 'high', 'xhigh']} />);
    expect(screen.getByRole('button', { name: /max/ })).toBeDisabled();
    expect(screen.getByText(/지원하지 않아|does not support/)).toBeInTheDocument();
  });
});

describe('ModelBadge', () => {
  it('draws a real logo for OpenAI (lobe-icons) and Google (Simple Icons), a dot only for unknown providers', () => {
    const { container } = render(
      <>
        <ModelBadge model="gpt-5" raw />
        <ModelBadge model="gemini-3-pro" raw />
      </>,
    );
    expect(container.querySelector('[data-provider="openai"]')?.tagName.toLowerCase()).toBe('svg');
    expect(container.querySelector('[data-provider="google"]')?.tagName.toLowerCase()).toBe('svg');
  });
});
