#!/usr/bin/env node
// open-alive hook (Node version): streams one Claude Code event to the local
// server. Used on Windows, where bash and curl are not guaranteed; behaves like
// stream-event.sh — 2s cap, silent on every failure, always exit 0, never
// blocks Claude Code.
//
// The event JSON arrives on stdin and is forwarded byte-for-byte; it is never
// interpolated into a command. AUTH: with remote mode on, the token is read from
// the 0600 env file on every run, as in the bash script.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function envValue(text, key) {
  let value;
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`).exec(line);
    if (m) value = m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return value;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  let port = process.env.OPEN_ALIVE_PORT ?? '';
  let token;
  try {
    const text = readFileSync(join(homedir(), '.open-alive', '.env'), 'utf-8');
    if (!port) port = envValue(text, 'OPEN_ALIVE_PORT') ?? '';
    token = envValue(text, 'OPEN_ALIVE_LOCAL_TOKEN');
  } catch {
    // no env file: defaults
  }
  if (!/^\d+$/.test(port)) port = '3141';

  await fetch(`http://localhost:${port}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
    signal: AbortSignal.timeout(2000),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
