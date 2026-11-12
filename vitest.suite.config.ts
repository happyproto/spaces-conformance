import { defineConfig } from 'vitest/config';

// The conformance suites. Run inside the harness container by cli/run.ts,
// one implementation per run, files in sequence (they share accounts).
export default defineConfig({
  test: {
    include: ['suites/**/*.test.ts'],
    fileParallelism: false,
    // Longer than a setup step's deadline (CONFORMANCE_SETUP_TIMEOUT_MS, 45 s),
    // so a hung setup step records error before the test times out.
    // harness/assert.ts ASSERTION_DEADLINE_MS (58 s) sits just under this.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['default', './harness/reporter.ts'],
  },
});
