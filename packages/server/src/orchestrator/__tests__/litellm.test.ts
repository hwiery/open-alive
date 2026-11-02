import { describe, it, expect } from 'vitest';
import { createLitellmClient, SESSION_HEADER } from '../litellmClient.js';
import { createBackendRegistry } from '../backends.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('createLitellmClient', () => {
  it('checkConnection lists model ids on success', async () => {
    const client = createLitellmClient(
      { baseUrl: 'https://gw.example/', apiKey: 'k' },
      { fetch: (async (url: string) => {
        expect(url).toBe('https://gw.example/v1/models');
        return jsonResponse({ data: [{ id: 'gemini/a' }, { id: 'gemini/b' }, {}] });
      }) as typeof fetch },
    );
    const r = await client.checkConnection();
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['gemini/a', 'gemini/b']);
  });

  it('checkConnection reports HTTP errors', async () => {
    const client = createLitellmClient(
      { baseUrl: 'https://gw.example', apiKey: 'k' },
      { fetch: (async () => jsonResponse({}, false, 401)) as typeof fetch },
    );
    expect(await client.checkConnection()).toEqual({ ok: false, error: 'HTTP 401' });
  });

  it('omits Authorization for a keyless gateway and sends it when a key is set', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      expect(init?.signal).toBeDefined();
      return jsonResponse({ data: [] });
    }) as typeof fetch;
    await createLitellmClient({ baseUrl: 'http://localhost:11434', apiKey: '' }, { fetch: fetchImpl }).checkConnection();
    await createLitellmClient({ baseUrl: 'http://localhost:11434', apiKey: 'k' }, { fetch: fetchImpl }).checkConnection();
    expect(seen[0]).not.toHaveProperty('Authorization');
    expect(seen[1]).toEqual({ Authorization: 'Bearer k' });
  });

  // The grok/kimi-k3 routes answer 400 "MissingSessionID"; the glm routes answer
  // 500 when the field IS present. So: plain first, session id only on demand.
  it('chat sends no session id on the first attempt', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = createLitellmClient(
      { baseUrl: 'https://gw.example', apiKey: 'k', sessionId: 'ses-42' },
      { fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      }) as typeof fetch },
    );
    await client.chat('glm-5.3', [{ role: 'user', content: 'hi' }]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('extra_headers');
  });

  it('chat retries once with a session id when the gateway asks for one', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = createLitellmClient(
      { baseUrl: 'https://gw.example', apiKey: 'k', sessionId: 'ses-42' },
      { fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return bodies.length === 1
          ? jsonResponse({ error: { message: 'MissingSessionID' } }, false, 400)
          : jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      }) as typeof fetch },
    );
    const r = await client.chat('kimi-k3', [{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.extra_headers).toEqual({ [SESSION_HEADER]: 'ses-42' });
  });

  it('chat generates a session id when none is configured', async () => {
    const bodies: Array<{ extra_headers?: Record<string, string> }> = [];
    const client = createLitellmClient(
      { baseUrl: 'https://gw.example', apiKey: 'k' },
      { fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return bodies.length === 1
          ? jsonResponse({ error: { message: 'MissingSessionID' } }, false, 400)
          : jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      }) as typeof fetch },
    );
    await client.chat('grok-4.5', [{ role: 'user', content: 'hi' }]);
    expect(bodies[1]?.extra_headers?.[SESSION_HEADER]).toMatch(/^open-alive-/);
  });

  it('chat does not retry a 400 that is about something else', async () => {
    let calls = 0;
    const client = createLitellmClient(
      { baseUrl: 'https://gw.example', apiKey: 'k' },
      { fetch: (async () => {
        calls += 1;
        return jsonResponse({ error: { message: 'Invalid model name' } }, false, 400);
      }) as typeof fetch },
    );
    await expect(client.chat('nope', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });

  it('chat returns content + usage', async () => {
    const client = createLitellmClient(
      { baseUrl: 'https://gw.example', apiKey: 'k' },
      { fetch: (async (_url: string, init: RequestInit) => {
        expect(JSON.parse(init.body as string).model).toBe('gemini/x');
        return jsonResponse({
          model: 'gemini/x',
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      }) as typeof fetch },
    );
    const r = await client.chat('gemini/x', [{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('hello');
    expect(r.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });
});

describe('createBackendRegistry', () => {
  const litellm = createLitellmClient(
    { baseUrl: 'https://gw.example', apiKey: 'k' },
    { fetch: (async () => jsonResponse({ data: [{ id: 'm1' }, { id: 'm2' }] })) as typeof fetch },
  );

  it('lists claude-local always and litellm only when configured; ssh is not a card', () => {
    expect(createBackendRegistry({}).list().map((b) => b.id)).toEqual(['claude-local']);
    expect(createBackendRegistry({ litellm }).list().map((b) => b.id)).toEqual(['claude-local', 'litellm']);
  });

  it('checks claude-local via findClaude', async () => {
    const ok = await createBackendRegistry({ findClaude: () => '/usr/bin/claude' }).check('claude-local');
    expect(ok.connected).toBe(true);
    const no = await createBackendRegistry({ findClaude: () => null }).check('claude-local');
    expect(no.connected).toBe(false);
  });

  it('reports the CLI version and the probed models once claude is found', async () => {
    const r = await createBackendRegistry({
      findClaude: () => '/usr/bin/claude',
      refreshClaude: async () => ({
        ok: true,
        snapshot: {
          models: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' },
          probed: ['sonnet', 'opus', 'fable'],
          version: '2.1.296 (Claude Code)',
        },
      }),
    }).check('claude-local');
    expect(r.connected).toBe(true);
    expect(r.models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']);
    expect(r.detail).toBe('2.1.296 (Claude Code) — Sonnet 5.5 · Opus 5.5 · Fable 5.1');
  });

  it('fails the claude check when the CLI is installed but cannot start a session', async () => {
    let refreshed = false;
    const missing = await createBackendRegistry({
      findClaude: () => null,
      refreshClaude: async () => {
        refreshed = true;
        throw new Error('must not probe without a binary');
      },
    }).check('claude-local');
    expect(missing.connected).toBe(false);
    expect(refreshed).toBe(false);

    const loggedOut = await createBackendRegistry({
      findClaude: () => '/usr/bin/claude',
      refreshClaude: async () => ({
        ok: false,
        error: 'Invalid API key · Please run /login',
        snapshot: { models: { haiku: 'h', sonnet: 'a', opus: 'b', fable: 'c' }, probed: [] },
      }),
    }).check('claude-local');
    expect(loggedOut).toMatchObject({ connected: false, detail: 'Invalid API key · Please run /login' });
  });

  it('lists Codex after Claude when enabled and reports its login and models', async () => {
    const registry = createBackendRegistry({
      refreshCodex: async () => ({
        ok: true,
        snapshot: {
          version: 'codex-cli 0.148.0',
          models: [
            { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: [], listed: true },
            { id: 'gpt-5.5', label: 'GPT-5.5', efforts: [], listed: false },
          ],
        },
      }),
    });
    expect(registry.list().map((b) => b.id)).toEqual(['claude-local', 'codex-local']);
    const r = await registry.check('codex-local');
    expect(r).toMatchObject({ connected: true, models: ['gpt-5.6-terra'], detail: 'codex-cli 0.148.0 — GPT-5.6-Terra' });
  });

  it('checks litellm connectivity + model count', async () => {
    const r = await createBackendRegistry({ litellm }).check('litellm');
    expect(r.connected).toBe(true);
    expect(r.models).toEqual(['m1', 'm2']);
    expect(r.detail).toBe('2 models');
  });

  it('reads the client through getLitellm on every call', async () => {
    let current: typeof litellm | undefined;
    const registry = createBackendRegistry({ getLitellm: () => current });
    expect(registry.list().map((b) => b.id)).toEqual(['claude-local']);
    current = litellm;
    expect(registry.list().map((b) => b.id)).toEqual(['claude-local', 'litellm']);
    expect((await registry.check('litellm')).connected).toBe(true);
  });

  it('reports litellm not configured', async () => {
    const r = await createBackendRegistry({}).check('litellm');
    expect(r.connected).toBe(false);
    expect(r.detail).toContain('not configured');
  });
});
