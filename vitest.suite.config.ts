import { defineConfig } from 'vitest/config';
import { TEST_TIMEOUT_MS } from './harness/timeouts.ts';

// The conformance suites. Run inside the harness container by cli/run.ts,
// one implementation per run, files in sequence (they share accounts).
export default defineConfig({
  test: {
    include: ['suites/**/*.test.ts'],
    fileParallelism: false,
    // harness/timeouts.ts keeps the setup step timeout below the assertion
    // deadline, and the deadline below this, so the harness classifies a slow
    // test itself before Vitest's timeout fires.
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: 120_000,
    reporters: ['default', './harness/reporter.ts'],
  },
});
