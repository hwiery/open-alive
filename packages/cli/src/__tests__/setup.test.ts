import { describe, it, expect } from 'vitest';
import {
  upsertEnvValue,
  readEnvKey,
  resolvePort,
  isValidPort,
  parseModelIds,
  buildModelsFile,
  DEFAULT_PORT,
} from '../setup.js';

describe('upsertEnvValue', () => {
  it('appends a new key and keeps other lines', () => {
    expect(upsertEnvValue('# note\nA=1', 'B', '2')).toBe('# note\nA=1\nB=2\n');
    expect(upsertEnvValue('', 'B', '2')).toBe('B=2\n');
  });

  it('replaces an existing key in place, including an `export` line', () => {
    expect(upsertEnvValue('A=1\nexport B=old\nC=3\n', 'B', 'new')).toBe('A=1\nB=new\nC=3\n');
  });

  it('removes the key for an empty or undefined value', () => {
    expect(upsertEnvValue('A=1\nB=2\n', 'A', undefined)).toBe('B=2\n');
    expect(upsertEnvValue('A=1\n', 'Z', '')).toBe('A=1\n');
  });

  it('ignores commented-out keys', () => {
    expect(upsertEnvValue('# B=old\n', 'B', 'x')).toBe('# B=old\nB=x\n');
  });

  it('rejects bad keys and multi-line values', () => {
    expect(() => upsertEnvValue('', '1BAD', 'x')).toThrow();
    expect(() => upsertEnvValue('', 'OK', 'a\nEVIL=1')).toThrow();
  });
});

describe('readEnvKey / resolvePort', () => {
  it('reads quoted and exported values', () => {
    expect(readEnvKey('export P="3200"\n', 'P')).toBe('3200');
  });

  it('prefers the process env, then the file, then the default', () => {
    expect(resolvePort({ OPEN_ALIVE_PORT: '4000' }, 'OPEN_ALIVE_PORT=5000')).toBe('4000');
    expect(resolvePort({}, 'OPEN_ALIVE_PORT=5000')).toBe('5000');
    expect(resolvePort({}, '')).toBe(DEFAULT_PORT);
  });

  it('validates ports', () => {
    expect(isValidPort('3141')).toBe(true);
    expect(isValidPort('0')).toBe(false);
    expect(isValidPort('70000')).toBe(false);
    expect(isValidPort('31a')).toBe(false);
  });
});

describe('parseModelIds / buildModelsFile', () => {
  it('extracts, dedupes and sorts ids from an OpenAI-style list', () => {
    expect(parseModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { nope: 1 }, null] })).toEqual(['a', 'b']);
    expect(parseModelIds({})).toEqual([]);
    expect(parseModelIds('garbage')).toEqual([]);
  });

  it('puts the default model first', () => {
    const file = buildModelsFile(['a', 'b', 'c'], 'b') as { defaultModel: string; models: Array<{ id: string }> };
    expect(file.defaultModel).toBe('b');
    expect(file.models.map((m) => m.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('writePrivateFile', () => {
  it('writes 0600 and refuses a planted symlink, even a dangling one', async () => {
    const { mkdtempSync, symlinkSync, statSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { writePrivateFile } = await import('../setup.js');
    const dir = mkdtempSync(join(tmpdir(), 'oa-setup-'));
    const file = join(dir, 'nested', '.env');
    writePrivateFile(file, 'A=1\n');
    expect(readFileSync(file, 'utf-8')).toBe('A=1\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const target = join(dir, 'elsewhere');
    const link = join(dir, 'link.env');
    symlinkSync(target, link);
    expect(() => writePrivateFile(link, 'SECRET=1\n')).toThrow(/symlink/);
    expect(existsSync(target)).toBe(false);
  });
});
