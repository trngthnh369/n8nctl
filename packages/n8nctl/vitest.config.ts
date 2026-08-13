import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index files are pure commander wiring; types/ is type-only (no runtime)
      exclude: ['src/index.ts', 'src/commands/**/index.ts', 'src/types/**'],
      // Ratcheted to just under actuals (76.3/61.8/79.7/77.3) so a regression
      // fails CI while normal churn doesn't. Raise as coverage grows.
      //
      // These moved when the suite went vitest 2 -> 4, whose AST-aware
      // remapping measures the TS source instead of the transpiled output. The
      // ruler changed, not the code — the denominators moved in BOTH
      // directions and the covered counts went UP:
      //
      //            vitest 2            vitest 4
      //   stmts    5158/6526 79.03%    2298/3013 76.26%   (over-counted stmts)
      //   branches 1266/1679 75.40%    1371/2219 61.78%   (missed ~32% of them)
      //   funcs     315/358  87.98%     405/508  79.72%   (missed ~42% of them)
      //   lines    5158/6526 79.03%    2156/2789 77.30%
      //
      // So 70% branches under the old ruler was never 70% of the real branches.
      // Headroom is ~2pts: cross-platform drift between the CI legs measures
      // ~0.3pt, and anything larger should be a deliberate decision, not churn.
      thresholds: {
        statements: 74,
        branches: 59,
        functions: 77,
        lines: 75,
      },
    },
  },
});
