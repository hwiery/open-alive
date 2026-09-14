import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseTranscriptTokens } from '../transcript/parser.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_DIR = join(tmpdir(), 'open-alive-test-transcript');

function setup() {
  mkdirSync(TMP_DIR, { recursive: true });
}

function cleanup() {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

function writeJsonl(filename: string, lines: object[]): string {
  const path = join(TMP_DIR, filename);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('parseTranscriptTokens', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('sums token usage from assistant entries', async () => {
    const path = writeJsonl('test.jsonl', [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        message: {
          id: 'msg_1', model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 },
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'msg_2', model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 80, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 400 },
        },
      },
    ]);

    const result = await parseTranscriptTokens(path);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(180);
    expect(result!.outputTokens).toBe(80);
    expect(result!.cacheCreationTokens).toBe(200);
    expect(result!.cacheReadTokens).toBe(700);
    expect(result!.totalTokens).toBe(1160);
    expect(result!.apiCalls).toBe(2);
    expect(result!.model).toBe('claude-opus-4-6');
  });

  it('deduplicates streaming chunks by message ID', async () => {
    const path = writeJsonl('stream.jsonl', [
      {
        type: 'assistant',
        message: {
          id: 'msg_1', model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          stop_reason: null,
          usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'msg_1', model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'full response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ]);

    const result = await parseTranscriptTokens(path);
    expect(result!.inputTokens).toBe(100);
    expect(result!.outputTokens).toBe(50);
    expect(result!.apiCalls).toBe(1);
  });

  it('returns null for nonexistent file', async () => {
    const result = await parseTranscriptTokens('/nonexistent/path.jsonl');
    expect(result).toBeNull();
  });

  it('returns null for empty file', async () => {
    const path = join(TMP_DIR, 'empty.jsonl');
    writeFileSync(path, '');
    const result = await parseTranscriptTokens(path);
    expect(result).toBeNull();
  });
});
