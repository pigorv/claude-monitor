import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 15_000,
    // The full suite is the union of the project `include` globs below.
    // A root-level `test.include` is intentionally omitted: with `projects`
    // defined, `extends: true` would inherit it into every project and make
    // each project run the whole suite (double-counting on a plain
    // `vitest run`). The two project globs partition all of `test/**` exactly
    // once, so `vitest run` (no --project) still runs the entire suite.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'test/ingestion/**/*.test.ts',
            'test/shared/**/*.test.ts',
            'test/analysis/**/*.test.ts',
            'test/frontend/**/*.test.ts',
            'test/export/**/*.test.ts',
            'test/db/queries/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'test/server/**/*.test.ts',
            'test/cli/**/*.test.ts',
            'test/db/*.test.ts',
            'test/db.test.ts',
          ],
        },
      },
    ],
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
