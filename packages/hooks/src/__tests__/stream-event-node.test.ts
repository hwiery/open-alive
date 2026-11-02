import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { hookCommandFor } from '../install.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'stream-event.mjs');

function runHook(home: string, stdin: string, env: NodeJS.ProcessEnv = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, HOME: home, USERPROFILE: home, OPEN_ALIVE_PORT: '', ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end(stdin);
    child.on('close', resolve);
  });
}

describe('stream-event.mjs (Windows hook)', () => {
  it('forwards the event body with the port and token from the env file', async () => {
    const received: { body: string; auth?: string; path?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ body, auth: req.headers.authorization, path: req.url });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const home = mkdtempSync(join(tmpdir(), 'hook-home-'));
    try {
      mkdirSync(join(home, '.open-alive'));
      writeFileSync(join(home, '.open-alive', '.env'), `OPEN_ALIVE_PORT=${port}\r\nOPEN_ALIVE_LOCAL_TOKEN="tok-1"\r\n`);
      const event = '{"hook_event_name":"PreToolUse","tool_input":{"command":"echo \\"$(rm -rf /)\\" & calc"}}';
      expect(await runHook(home, event)).toBe(0);
      expect(received).toEqual([{ body: event, auth: 'Bearer tok-1', path: '/api/event' }]);
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits 0 quickly when the server is down', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-home-'));
    try {
      const started = Date.now();
      expect(await runHook(home, '{}', { OPEN_ALIVE_PORT: '1' })).toBe(0);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('hookCommandFor', () => {
  it('runs the Node hook through node on Windows and the bash script directly elsewhere', () => {
    expect(hookCommandFor('C:\\Users\\u\\.open-alive\\hooks\\stream-event.mjs', 'win32')).toBe(
      'node "C:\\Users\\u\\.open-alive\\hooks\\stream-event.mjs"',
    );
    expect(hookCommandFor('/home/u/.open-alive/hooks/stream-event.sh', 'linux')).toBe('/home/u/.open-alive/hooks/stream-event.sh');
  });
});
