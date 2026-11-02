import { describe, expect, it } from 'vitest';
import {
  PROJECT_SIDEBAR_WIDTH,
  REPO_SIDEBAR_WIDTH,
  layoutInsets,
  sidebarFor,
} from '../state/layoutInsets.ts';

describe('sidebarFor', () => {
  it('gives the session views the session sidebar only', () => {
    expect(sidebarFor('animation')).toBe('sessions');
    expect(sidebarFor('list')).toBe('sessions');
  });

  it('gives every other view the repo sidebar', () => {
    for (const view of ['tickets', 'board', 'workspace', 'spread']) expect(sidebarFor(view), view).toBe('repo');
  });
});

describe('layoutInsets', () => {
  it('reserves the repo sidebar width in the ticket views', () => {
    expect(layoutInsets(true, 'tickets')).toEqual({ body: REPO_SIDEBAR_WIDTH, list: REPO_SIDEBAR_WIDTH });
    expect(layoutInsets(true).body).toBe(REPO_SIDEBAR_WIDTH);
  });

  it('reserves only the session sidebar in the session views', () => {
    expect(layoutInsets(true, 'list')).toEqual({ body: PROJECT_SIDEBAR_WIDTH, list: PROJECT_SIDEBAR_WIDTH });
    expect(layoutInsets(true, 'animation').body).toBe(PROJECT_SIDEBAR_WIDTH);
  });

  it('reserves nothing once the left panel is collapsed', () => {
    for (const view of ['tickets', 'animation', 'list']) expect(layoutInsets(false, view)).toEqual({ body: 0, list: 0 });
  });
});
