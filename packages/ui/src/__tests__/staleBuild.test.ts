import { describe, it, expect } from 'vitest';
import { shouldReloadForStaleBuild } from '../lib/staleBuild.ts';

describe('shouldReloadForStaleBuild', () => {
  it('reloads the first time, then not again within 30s (no reload loop)', () => {
    expect(shouldReloadForStaleBuild(null, 1_000)).toBe(true);
    expect(shouldReloadForStaleBuild(1_000, 20_000)).toBe(false);
    expect(shouldReloadForStaleBuild(1_000, 40_000)).toBe(true);
  });
});
