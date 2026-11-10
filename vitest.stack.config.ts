import { defineConfig } from 'vitest/config';

// Tests that need a live stack; run inside the harness container (cli/stack.sh test).
export default defineConfig({
  test: { include: ['test/stack/**/*.stack.test.ts'], testTimeout: 60_000 },
});
