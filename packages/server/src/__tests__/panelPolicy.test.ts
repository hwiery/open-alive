import { describe, it, expect } from 'vitest';
import { delimiter, resolve } from 'node:path';
import { parsePanelExcludedRoots, isUnderRoot, panelAllowedFor } from '../panel/panelPolicy.js';

describe('parsePanelExcludedRoots', () => {
  it('is empty when unset', () => {
    expect(parsePanelExcludedRoots({})).toEqual([]);
  });
  it('splits (`:`, or `;` on Windows), trims and normalizes the list', () => {
    const raw = ['/secret/', ' /work/a ', '', ''].join(delimiter);
    expect(parsePanelExcludedRoots({ OPEN_ALIVE_PANEL_EXCLUDE: raw })).toEqual([resolve('/secret'), resolve('/work/a')]);
  });
});

describe('isUnderRoot', () => {
  it('matches the root itself and anything inside it', () => {
    expect(isUnderRoot('/secret', ['/secret'])).toBe(true);
    expect(isUnderRoot('/secret/repo/src', ['/secret'])).toBe(true);
  });
  it('does not match a sibling that merely shares a prefix', () => {
    expect(isUnderRoot('/secretive', ['/secret'])).toBe(false);
  });
  it('is false with no roots', () => {
    expect(isUnderRoot('/anywhere', [])).toBe(false);
  });
});

describe('panelAllowedFor', () => {
  it('allows a ticket by default', () => {
    expect(panelAllowedFor({ cwd: '/work/repo' }, [])).toBe(true);
  });
  it('honours the ticket opt-out', () => {
    expect(panelAllowedFor({ cwd: '/work/repo', panelReview: false }, [])).toBe(false);
  });
  it('compares Windows paths case- and separator-insensitively', () => {
    if (process.platform !== 'win32') return;
    expect(isUnderRoot('c:/Secret/repo', ['C:\\secret'])).toBe(true);
  });
  it('honours an operator-excluded tree', () => {
    expect(panelAllowedFor({ cwd: '/secret/repo' }, ['/secret'])).toBe(false);
  });
  it('does not let a ticket opt back into an excluded tree', () => {
    expect(panelAllowedFor({ cwd: '/secret/repo', panelReview: true }, ['/secret'])).toBe(false);
  });
});
