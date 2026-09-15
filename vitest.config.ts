import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core/vitest.config.ts',
      'packages/storage/vitest.config.ts',
      'packages/server/vitest.config.ts',
      'packages/hooks/vitest.config.ts',
      'packages/cli/vitest.config.ts',
      'packages/ui/vitest.config.ts',
      'packages/i18n/vitest.config.ts',
      'packages/prompt-core/vitest.config.ts',
      'packages/prompt-rules/vitest.config.ts',
      'packages/prompt-worker/vitest.config.ts',
      'packages/prompt-agent/vitest.config.ts',
    ],
  },
});
