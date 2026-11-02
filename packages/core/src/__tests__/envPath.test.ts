import { describe, it, expect } from 'vitest';
import { augmentPath, findExecutable, pathDelimiter, splitPathList } from '../env/path.js';

describe('augmentPath', () => {
  it('keeps the POSIX layout: user bins first, system tail last', () => {
    expect(augmentPath('/a:/usr/bin', '/home/u', 'linux', {})).toBe(
      '/home/u/.local/bin:/home/u/.npm-global/bin:/home/u/bin:/opt/homebrew/bin:/usr/local/bin:/a:/usr/bin:/bin',
    );
  });

  it('uses ; and the npm / native-installer dirs on Windows, deduped case-insensitively', () => {
    const out = augmentPath('C:\\Windows\\system32;c:\\users\\u\\appdata\\roaming\\npm', 'C:\\Users\\u', 'win32', {
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    });
    expect(out).toBe('C:\\Users\\u\\.local\\bin;C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Windows\\system32');
  });
});

describe('findExecutable', () => {
  it('finds a POSIX binary by its bare name', () => {
    const files = new Set(['/x/bin/claude']);
    expect(findExecutable('claude', '/nope:/x/bin', 'darwin', {}, (p) => files.has(p))).toBe('/x/bin/claude');
  });

  it('tries PATHEXT on Windows and never returns an extensionless file', () => {
    const files = new Set(['C:\\npm\\claude', 'C:\\npm\\claude.cmd']);
    expect(findExecutable('claude', 'C:\\a;C:\\npm', 'win32', { PATHEXT: '.EXE;.CMD' }, (p) => files.has(p))).toBe('C:\\npm\\claude.cmd');
    expect(findExecutable('codex', 'C:\\npm', 'win32', {}, () => false)).toBeNull();
  });
});

describe('path lists', () => {
  it('splits user path lists with the platform delimiter', () => {
    expect(pathDelimiter('win32')).toBe(';');
    expect(splitPathList('C:\\work; D:\\repo ;', 'win32')).toEqual(['C:\\work', 'D:\\repo']);
    expect(splitPathList('/a:/b', 'linux')).toEqual(['/a', '/b']);
    expect(splitPathList(undefined, 'linux')).toEqual([]);
  });
});

describe('findExecutable ignores relative PATH entries', () => {
  it('never resolves through ., an empty entry, or a relative dir (they point into the cwd)', () => {
    const files = new Set(['./claude', 'claude', 'repo/bin/claude', '.\\claude.cmd', 'C:\\safe\\claude.cmd']);
    const isFile = (p: string) => files.has(p);
    expect(findExecutable('claude', '.::repo/bin', 'linux', {}, isFile)).toBeNull();
    expect(findExecutable('claude', '.;;C:\\safe', 'win32', { PATHEXT: '.CMD' }, isFile)).toBe('C:\\safe\\claude.cmd');
  });
});
