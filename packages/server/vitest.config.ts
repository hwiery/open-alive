import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Pin the built-in model preset so a developer's ~/.open-alive/models.json
    // cannot change what the catalogue tests see.
    env: { OA_DELEGATE_MODELS_FILE: 'builtin' },
  },
});
