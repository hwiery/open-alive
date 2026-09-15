import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DELEGATE_MODELS,
  DEFAULT_FALLBACK_TAIL,
  buildDelegateChain,
  describeDelegateModels,
  findDelegateModel,
  resolveModelId,
  parseDelegateCatalog,
  loadDelegateCatalog,
  BUILTIN_DELEGATE_MODELS,
} from '../delegateModels.js';

describe('catalogue integrity', () => {
  it('has unique ids and aliases', () => {
    const ids = DELEGATE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const aliases = DELEGATE_MODELS.flatMap((m) => m.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  // A fallback pointing at an id the gateway does not serve would turn one
  // failure into two, so every hop must name a catalogue entry.
  it('only falls back to models that exist in the catalogue', () => {
    const ids = new Set(DELEGATE_MODELS.map((m) => m.id));
    for (const m of DELEGATE_MODELS) {
      for (const f of m.fallbacks) expect(ids.has(f), `${m.id} → ${f}`).toBe(true);
    }
    for (const f of DEFAULT_FALLBACK_TAIL) expect(ids.has(f)).toBe(true);
  });

  it('never lists a model as its own fallback', () => {
    for (const m of DELEGATE_MODELS) expect(m.fallbacks).not.toContain(m.id);
  });
});

describe('findDelegateModel / resolveModelId', () => {
  it('matches by id and by alias, case-insensitively', () => {
    expect(findDelegateModel('code')?.id).toBe('code-model');
    expect(findDelegateModel('CODE-MODEL')?.id).toBe('code-model');
    expect(findDelegateModel(' second ')?.id).toBe('reasoning-model-b');
  });

  it('passes an unknown id through (the gateway catalogue rotates)', () => {
    expect(findDelegateModel('brand/new-model')).toBeUndefined();
    expect(resolveModelId('brand/new-model')).toBe('brand/new-model');
  });
});

describe('buildDelegateChain', () => {
  it('appends the catalogue fallbacks to a known model', () => {
    expect(buildDelegateChain('code')).toEqual(['code-model', ...DELEGATE_MODELS.find((m) => m.id === 'code-model')!.fallbacks]);
  });

  it('gives an unknown model the cross-vendor default tail', () => {
    expect(buildDelegateChain('brand/new')).toEqual(['brand/new', ...DEFAULT_FALLBACK_TAIL]);
  });

  it('takes an explicit multi-model chain literally', () => {
    expect(buildDelegateChain('second, code ,fast')).toEqual(['reasoning-model-b', 'code-model', 'fast-model']);
  });

  it('pins to one model under --no-fallback', () => {
    expect(buildDelegateChain('second', { noFallback: true })).toEqual(['reasoning-model-b']);
  });

  it('lets OA_DELEGATE_FALLBACKS replace the tail', () => {
    expect(buildDelegateChain('code', { fallbackOverride: 'pro, fast' })).toEqual([
      'code-model',
      'reasoning-model-a',
      'fast-model',
    ]);
  });

  it('dedupes when the override repeats the primary', () => {
    expect(buildDelegateChain('pro', { fallbackOverride: 'pro, second' })).toEqual([
      'reasoning-model-a',
      'reasoning-model-b',
    ]);
  });

  it('returns nothing for an empty request', () => {
    expect(buildDelegateChain('   ')).toEqual([]);
  });
});

describe('built-in preset', () => {
  // The preset holds placeholders only: which models exist is up to the
  // user's gateway. It must stay the same table the shipped example documents.
  it('mirrors examples/models.example.json', () => {
    const example = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../../examples/models.example.json'), 'utf-8'),
    ) as { models: { id: string; aliases: string[]; kind: string; fallbacks: string[] }[] };
    expect(
      BUILTIN_DELEGATE_MODELS.map(({ id, aliases, kind, fallbacks }) => ({ id, aliases, kind, fallbacks })),
    ).toEqual(example.models.map(({ id, aliases, kind, fallbacks }) => ({ id, aliases, kind, fallbacks })));
  });
});

describe('describeDelegateModels', () => {
  it('lists every model with its primary alias', () => {
    const text = describeDelegateModels();
    expect(text.split('\n')).toHaveLength(DELEGATE_MODELS.length);
    expect(text).toContain('code (code-model)');
    expect(text).toContain('second (reasoning-model-b)');
  });
});

describe('user catalogue (models.json)', () => {
  const file = JSON.stringify({
    defaultModel: 'gpt-mini',
    panelModels: ['a', 'b', 'c'],
    models: [
      { id: 'gpt-mini', aliases: ['mini'], kind: 'fast', note: 'cheap', fallbacks: ['gpt-big', 'gpt-mini'] },
      { id: 'gpt-big', kind: 'nonsense' },
    ],
  });

  it('parses a valid file, drops self-fallbacks and defaults unknown kinds', () => {
    const c = parseDelegateCatalog(JSON.parse(file), '/x/models.json');
    if ('error' in c) throw new Error(c.error);
    expect(c.models.map((m) => m.id)).toEqual(['gpt-mini', 'gpt-big']);
    expect(c.models[0]!.fallbacks).toEqual(['gpt-big']);
    expect(c.models[1]!.kind).toBe('utility');
    expect(c.defaultModel).toBe('gpt-mini');
    expect(c.panelModels).toEqual(['a', 'b', 'c']);
    expect(c.fallbackTail).toEqual(['gpt-mini', 'gpt-big']);
  });

  it('rejects a file without models', () => {
    expect(parseDelegateCatalog({ models: [] }, 'f')).toHaveProperty('error');
    expect(parseDelegateCatalog([], 'f')).toHaveProperty('error');
    expect(parseDelegateCatalog({ models: [{ aliases: ['x'] }] }, 'f')).toHaveProperty('error');
  });

  it('loads the file named by OA_DELEGATE_MODELS_FILE', () => {
    const c = loadDelegateCatalog({ OA_DELEGATE_MODELS_FILE: '/x/models.json' }, () => file);
    expect(c.source).toBe('/x/models.json');
    expect(c.models).toHaveLength(2);
  });

  it('falls back to the built-in preset when the file is missing, broken, or pinned', () => {
    const missing = loadDelegateCatalog({}, () => {
      throw new Error('ENOENT');
    });
    expect(missing.source).toBe('builtin');
    const broken = loadDelegateCatalog({ OA_DELEGATE_MODELS_FILE: '/x' }, () => '{not json');
    expect(broken.models).toBe(BUILTIN_DELEGATE_MODELS);
    expect(loadDelegateCatalog({ OA_DELEGATE_MODELS_FILE: 'builtin' }, () => file).source).toBe('builtin');
  });
});
