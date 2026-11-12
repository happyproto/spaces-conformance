// The suite's timeouts, in one place so they can't drift apart.
// vitest.suite.config.ts takes its testTimeout from here.

/** Vitest's per-test timeout for the suites. */
export const TEST_TIMEOUT_MS = 60_000;

/** How long one assertion may run in all (runAssertion's deadline): just under the test timeout. */
export const ASSERTION_DEADLINE_MS = Number(process.env.CONFORMANCE_ASSERTION_DEADLINE_MS ?? TEST_TIMEOUT_MS - 2_000);

/** How long one setup step may take. */
export const SETUP_TIMEOUT_MS = Number(process.env.CONFORMANCE_SETUP_TIMEOUT_MS ?? 45_000);

/** Refuse timeouts that would let Vitest's timeout fire before the harness classifies the test. */
export function checkTimeouts(t = { test: TEST_TIMEOUT_MS, deadline: ASSERTION_DEADLINE_MS, setup: SETUP_TIMEOUT_MS }): void {
  if (!(t.deadline < t.test)) throw new Error(`the assertion deadline (${t.deadline} ms) must be below the test timeout (${t.test} ms)`);
  if (!(t.setup < t.deadline)) throw new Error(`the setup step timeout (${t.setup} ms) must be below the assertion deadline (${t.deadline} ms)`);
}
checkTimeouts();
