import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      thresholds: {
        lines: 62,
        branches: 50,
        functions: 54,
        statements: 60,
        'src/ingestion/token-tracker.ts': { lines: 95 },
        'src/ingestion/jsonl-parser.ts': { lines: 95 },
        'src/db/migrations.ts': { lines: 95 },
        'src/analysis/compaction-analysis.ts': { lines: 95 },
      },
    },
  },
});
