import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'cli',
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
