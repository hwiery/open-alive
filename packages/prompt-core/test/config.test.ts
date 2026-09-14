import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../src/config.js';
import { getPaths } from '../src/paths.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'oa-prompt-config-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('prompt config defaults', () => {
  // Regression: a bare `.default({})` skipped inner defaults under zod 4, so a
  // fresh install started Fastify with `bodyLimit: NaN`.
  it('fills every nested default on a fresh install', () => {
    const cfg = defaultConfig();
    expect(cfg.agent.max_prompt_bytes).toBe(262144);
    expect(cfg.agent.fail_open).toBe(true);
    expect(cfg.privacy.pii_mask).toBe(true);
    expect(cfg.llm.enabled).toBe(false);
    expect(cfg.rules.custom_disabled).toEqual([]);
    expect(cfg.analysis.deep_consent).toBe('pending');
  });

  it('fills missing sections and fields in an existing config file', () => {
    const file = getPaths(tmp).configFile;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ agent: { coach_mode: true } }));
    const cfg = loadConfig(tmp);
    expect(cfg.agent.coach_mode).toBe(true);
    expect(cfg.agent.max_prompt_bytes).toBe(262144);
    expect(cfg.dashboard.port).toBe(47824);
  });
});
