import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readServerVersion } from '../serverVersion.js';

describe('readServerVersion', () => {
  it('reports the root open-alive package version in the workspace', () => {
    const root = JSON.parse(readFileSync(resolve(__dirname, '../../../../package.json'), 'utf-8'));
    expect(readServerVersion()).toBe(root.version);
  });

  it('skips package.json files that belong to other packages', () => {
    const base = mkdtempSync(join(tmpdir(), 'oa-version-'));
    const nested = join(base, 'packages', 'server', 'dist');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(base, 'package.json'), JSON.stringify({ name: 'open-alive', version: '9.9.9' }));
    writeFileSync(join(base, 'packages', 'server', 'package.json'), JSON.stringify({ name: '@open-alive/server', version: '0.0.1' }));
    expect(readServerVersion(nested)).toBe('9.9.9');
  });

  it('returns unknown when no open-alive package.json is found', () => {
    expect(readServerVersion(mkdtempSync(join(tmpdir(), 'oa-version-none-')))).toBe('unknown');
  });
});
