import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    fileParallelism: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
