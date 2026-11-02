import { describe, it, expect } from 'vitest';
import { resolveLocalModel } from '../localModel.js';
import { buildCodexCommand } from '../claudeTerminal.js';

describe('resolveLocalModel', () => {
  it('is null when OA_LOCAL_MODEL is unset or blank', () => {
    expect(resolveLocalModel({})).toBeNull();
    expect(resolveLocalModel({ OA_LOCAL_MODEL: '  ' })).toBeNull();
  });

  it('defaults the provider to ollama', () => {
    expect(resolveLocalModel({ OA_LOCAL_MODEL: 'gemma4:12b-it-qat' })).toEqual({
      model: 'gemma4:12b-it-qat',
      provider: 'ollama',
    });
  });

  it('accepts lmstudio as the provider', () => {
    expect(resolveLocalModel({ OA_LOCAL_MODEL: 'qwen/qwen3-8b', OA_LOCAL_PROVIDER: 'lmstudio' })).toEqual({
      model: 'qwen/qwen3-8b',
      provider: 'lmstudio',
    });
  });

  it('rejects an unknown provider and shell metacharacters in the model name', () => {
    expect(resolveLocalModel({ OA_LOCAL_MODEL: 'gemma4', OA_LOCAL_PROVIDER: 'vllm' })).toBeNull();
    expect(resolveLocalModel({ OA_LOCAL_MODEL: 'gemma4; rm -rf ~' })).toBeNull();
    expect(resolveLocalModel({ OA_LOCAL_MODEL: '$(whoami)' })).toBeNull();
  });
});

describe('buildCodexCommand with a local model', () => {
  const local = { model: 'gemma4:12b-it-qat', provider: 'ollama' as const };

  it('runs codex on the open-source provider', () => {
    expect(buildCodexCommand({ local })).toBe("codex --oss --local-provider ollama -m 'gemma4:12b-it-qat'");
  });

  it('keeps the bypass flag when skipping permissions', () => {
    expect(buildCodexCommand({ local, skipPermissions: true })).toBe(
      "codex --oss --local-provider ollama -m 'gemma4:12b-it-qat' --dangerously-bypass-approvals-and-sandbox",
    );
  });
});

describe('ClaudeTerminal local codex spawn', () => {
  it('refuses to start instead of falling back to the cloud model when no local model is set', async () => {
    const { ClaudeTerminal } = await import('../claudeTerminal.js');
    const saved = process.env.OA_LOCAL_MODEL;
    delete process.env.OA_LOCAL_MODEL;
    try {
      expect(() => new ClaudeTerminal().spawn({ handler: () => {}, mode: 'codex', localModel: true })).toThrow(/OA_LOCAL_MODEL/);
    } finally {
      if (saved !== undefined) process.env.OA_LOCAL_MODEL = saved;
    }
  });
});
