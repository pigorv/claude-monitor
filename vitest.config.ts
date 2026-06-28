import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 15_000,
    // The full suite is the union of the two projects below. A root-level
    // `test.include` is intentionally omitted: with `projects` defined,
    // `extends: true` would inherit it into every project and make each one
    // run the whole suite (double-counting on a plain `vitest run`).
    //
    // The projects are exhaustive by construction: `integration` is an explicit
    // allow-list of L2 specs, and `unit` is a catch-all (everything except the
    // integration globs). A newly added test file therefore always lands in one
    // project — never in neither — so it can never be silently skipped by the
    // split or by a plain `vitest run` / `npm run coverage`.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [
            'test/server/**/*.test.ts',
            'test/cli/**/*.test.ts',
            'test/db/*.test.ts',
            'test/db.test.ts',
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
