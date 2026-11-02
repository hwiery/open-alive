import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { createStaticHandler, cacheControlFor } from '../staticFiles.js';

const dist = mkdtempSync(join(tmpdir(), 'ui-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="/assets/index-new.js"></script>');
writeFileSync(join(dist, 'assets', 'index-new.js'), 'console.log(1)');
afterAll(() => rmSync(dist, { recursive: true, force: true }));

function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      out.status = status;
      out.headers = headers;
    },
    end: (data: Buffer | string) => {
      out.body = String(data);
    },
  } as unknown as ServerResponse;
  return { res, out };
}

describe('static files after an update', () => {
  const serve = createStaticHandler(dist);

  it('serves the shell with no-cache so a new build is picked up on reload', async () => {
    const { res, out } = fakeRes();
    expect(await serve('/', res)).toBe(true);
    expect(out.headers?.['Cache-Control']).toBe('no-cache');
  });

  it('caches hashed assets for good', async () => {
    const { res, out } = fakeRes();
    expect(await serve('/assets/index-new.js', res)).toBe(true);
    expect(out.headers?.['Cache-Control']).toContain('immutable');
    expect(out.headers?.['Content-Type']).toContain('javascript');
  });

  it("answers a previous build's asset with 404, not with the HTML shell", async () => {
    const { res, out } = fakeRes();
    expect(await serve('/assets/index-old.js', res)).toBe(false);
    expect(out.status).toBeUndefined();
  });

  it('still serves the shell for client-side routes', async () => {
    const { res, out } = fakeRes();
    expect(await serve('/tickets/abc', res)).toBe(true);
    expect(out.headers?.['Content-Type']).toContain('text/html');
    expect(out.headers?.['Cache-Control']).toBe('no-cache');
  });

  it('chooses the cache policy by path', () => {
    expect(cacheControlFor('/assets/x.css', '.css')).toContain('immutable');
    expect(cacheControlFor('/favicon.svg', '.svg')).toBe('no-cache');
  });
});
