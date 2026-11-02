import { describe, it, expect } from 'vitest';
import {
  LAUNCH_PROFILES,
  LAUNCH_PROFILE_KEY,
  DEFAULT_LAUNCH_PROFILE,
  loadLaunchProfile,
  saveLaunchProfile,
  availableLaunchProfiles,
  resolveLaunchProfile,
} from '../state/launchProfile.ts';

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

describe('launch profiles', () => {
  it('offers claude and codex, each with and without skipping permissions', () => {
    expect(LAUNCH_PROFILES.map((p) => [p.agent, p.skipPermissions, p.local])).toEqual([
      ['claude', false, false],
      ['claude', true, false],
      ['codex', false, false],
      ['codex', true, false],
      ['codex', false, true],
      ['codex', true, true],
    ]);
  });

  it('offers the local-model presets only when the server has a local model', () => {
    expect(availableLaunchProfiles(false).map((p) => p.id)).toEqual(['claude', 'claude-skip', 'codex', 'codex-skip']);
    expect(availableLaunchProfiles(true).map((p) => p.id)).toContain('codex-local-skip');
  });

  it('falls back to the default when a saved local preset is no longer available', () => {
    expect(resolveLaunchProfile('codex-local', false).id).toBe('claude-skip');
    expect(resolveLaunchProfile('codex-local', true).id).toBe('codex-local');
  });

  it('defaults to claude with skip-permissions (the previous default)', () => {
    expect(DEFAULT_LAUNCH_PROFILE).toBe('claude-skip');
    expect(loadLaunchProfile(memoryStorage())).toBe('claude-skip');
    expect(loadLaunchProfile(undefined)).toBe('claude-skip');
  });

  it('round-trips a saved choice', () => {
    const storage = memoryStorage();
    saveLaunchProfile(storage, 'codex-skip');
    expect(loadLaunchProfile(storage)).toBe('codex-skip');
  });

  it('falls back to the default for an unknown stored value', () => {
    expect(loadLaunchProfile(memoryStorage({ [LAUNCH_PROFILE_KEY]: 'gemini' }))).toBe('claude-skip');
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(loadLaunchProfile(broken)).toBe('claude-skip');
    expect(() => saveLaunchProfile(broken, 'codex')).not.toThrow();
  });
});
