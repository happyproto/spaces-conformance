import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The first run fetches the pinned proposal text.
    testTimeout: 20_000,
  },
});
