import { describe, it, expect } from 'vitest';
import {
  VIEW_MODE_META,
  viewsInGroup,
  groupOf,
  normalizeViewMode,
} from '../components/viewGroups.ts';

describe('viewGroups', () => {
  it('places tickets alone in the primary group', () => {
    const primary = viewsInGroup('primary');
    expect(primary.map((m) => m.mode)).toEqual(['tickets']);
  });

  it('groups the three terminal layouts — window, split, full — in that order', () => {
    expect(viewsInGroup('terminal').map((m) => [m.mode, m.labelKey])).toEqual([
      ['animation', 'viewMode.layout.window'],
      ['spread', 'viewMode.layout.split'],
      ['list', 'viewMode.layout.full'],
    ]);
  });

  it('tells terminal layouts apart from tickets and cost', async () => {
    const { isTerminalView } = await import('../components/viewGroups.ts');
    expect(['animation', 'spread', 'list'].every((m) => isTerminalView(m as never))).toBe(true);
    expect(isTerminalView('tickets')).toBe(false);
    expect(isTerminalView('board')).toBe(false);
  });

  it('keeps only Cost (internal id board) under tools — workspace is gone', () => {
    expect(viewsInGroup('tools').map((m) => [m.mode, m.labelKey])).toEqual([['board', 'viewMode.cost']]);
  });

  it('sends a saved workspace view to tickets', async () => {
    const { normalizeViewMode } = await import('../components/viewGroups.ts');
    expect(normalizeViewMode('workspace')).toBe('tickets');
    expect(normalizeViewMode('data')).toBe('board');
  });

  it('assigns every surfaced view to exactly one group (no gaps, no dupes)', () => {
    const modes = VIEW_MODE_META.map((m) => m.mode);
    expect(new Set(modes).size).toBe(modes.length); // no duplicates
    for (const m of VIEW_MODE_META) {
      expect(groupOf(m.mode)).toBe(m.group);
    }
  });

  it('does not surface jarvis in the header', () => {
    expect(groupOf('jarvis')).toBeUndefined();
  });

  it('gives every entry a viewMode.* label key', () => {
    for (const m of VIEW_MODE_META) {
      expect(m.labelKey).toMatch(/^viewMode\./);
    }
  });

  it.each(['prompt', 'archive', 'ticketMgmt', 'data'] as const)(
    'normalizes legacy %s navigation to board',
    (mode) => {
      expect(normalizeViewMode(mode)).toBe('board');
    },
  );

  it('preserves non-legacy navigation modes', () => {
    expect(normalizeViewMode('tickets')).toBe('tickets');
    expect(normalizeViewMode('spread')).toBe('spread');
  });
});
