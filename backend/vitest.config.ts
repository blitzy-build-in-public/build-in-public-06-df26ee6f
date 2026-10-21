import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
      thresholds: {
        'src/domain/**': { lines: 90, statements: 90, functions: 90, branches: 90 },
        'src/application/**': { lines: 90, statements: 90, functions: 90, branches: 90 },
      },
    },
  },
});
