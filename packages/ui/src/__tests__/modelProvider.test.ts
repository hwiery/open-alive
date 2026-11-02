import { describe, it, expect } from 'vitest';
import { modelProvider } from '../services/modelProvider.ts';

describe('modelProvider', () => {
  it.each([
    ['claude-opus-5-5', 'anthropic'],
    ['claude-sonnet-5-5[1m]', 'anthropic'],
    ['opus', 'anthropic'],
    ['openrouter/anthropic/claude-sonnet-5', 'anthropic'],
    ['gpt-5.1-codex', 'openai'],
    ['o3-mini', 'openai'],
    ['openai/gpt-5', 'openai'],
    ['gemini/gemini-3.1-pro-preview', 'google'],
    ['gemma-3-27b', 'google'],
    ['ollama/llama4:scout', 'meta'],
    ['meta-llama/Llama-4-Maverick', 'meta'],
    ['mistral-large-latest', 'mistral'],
    ['codestral-2508', 'mistral'],
    ['deepseek-r2', 'deepseek'],
    ['xai/grok-4', 'xai'],
    ['qwen3-coder-480b', 'qwen'],
    ['moonshotai/kimi-k2', 'moonshot'],
    ['glm-4.6', 'zhipu'],
    ['some-local-model', 'other'],
    ['', 'other'],
  ])('%s → %s', (model, provider) => {
    expect(modelProvider(model)).toBe(provider);
  });
});
