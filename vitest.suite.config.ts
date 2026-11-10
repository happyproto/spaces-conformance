import { defineConfig } from 'vitest/config';

// The conformance suites. Run inside the harness container by cli/run.ts,
// one implementation per run, files in sequence (they share accounts).
export default defineConfig({
  test: {
    include: ['suites/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['default', './harness/reporter.ts'],
  },
});
