// Declaring a test for an assertion. Each `assertion(id, fn)` becomes one
// Vitest test, and records one raw result (pass, fail, error or skip) to
// the run's raw directory, which the reporter assembles into the results file.
//
//   - Not applicable by role, profile or capability: skip, with the reason.
//   - A throw from setup(), or from anything before fn's own checks: error.
//   - A failed check (fail(), or a Vitest expect): fail, with evidence.

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { type RunContext, runContext } from './context.ts';
import { notApplicable } from './manifest.ts';
import { EVIDENCE_LIMIT } from './results.ts';
import { ROOT } from './schema.ts';
import { ASSERTION_DEADLINE_MS, SETUP_TIMEOUT_MS } from './timeouts.ts';

export { ASSERTION_DEADLINE_MS, SETUP_TIMEOUT_MS };

export interface RawResult {
  id: string;
  suite: string;
  status: 'pass' | 'fail' | 'error' | 'skip';
  ms?: number;
  message?: string;
  skip_reason?: string;
  evidence?: Record<string, unknown>;
}

/** Setup went wrong: recorded as `error`, never scored. */
export class SetupError extends Error {
  readonly step: string;
  readonly cause?: unknown;
  constructor(step: string, cause: unknown) {
    super(`setup failed at ${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.step = step;
    this.cause = cause;
  }
}

/**
 * The assertion can't be judged until the harness grows a capability (e.g.
 * the space-credential read path). Recorded as `skip` with a "pending:"
 * reason, not `error`: it's permanent until then, and an `error` would rerun
 * the stack and fail a gated run as infrastructure.
 */
export class Pending extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`pending: ${reason}`);
    this.reason = reason;
  }
}

export const pending = (reason: string): never => {
  throw new Pending(reason);
};

/** A check failed, with what the host actually answered. */
export class AssertionFailure extends Error {
  readonly evidence?: Record<string, unknown>;
  constructor(message: string, evidence?: Record<string, unknown>) {
    super(message);
    this.evidence = evidence;
  }
}

export const fail = (message: string, evidence?: Record<string, unknown>): never => {
  throw new AssertionFailure(message, evidence);
};

/** The assertion whose test is running, so setup() can mark its steps. */
const current = new AsyncLocalStorage<string>();

/** Setup steps open right now, per assertion id, in start order. */
const openSteps = new Map<string, string[]>();
/** Mark a setup step's start and end: in memory for runAssertion(), on disk for reconcile(). */
function mark(phase: 'start' | 'end', step: string) {
  const id = current.getStore();
  if (!id) return;
  const open = openSteps.get(id) ?? [];
  if (phase === 'start') open.push(step);
  else {
    const i = open.lastIndexOf(step);
    if (i >= 0) open.splice(i, 1);
  }
  openSteps.set(id, open);
  const dir = rawDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${process.pid}.setup.jsonl`), `${JSON.stringify({ id, step, phase })}\n`);
}

/** Run a setup step: a throw, or running past SETUP_TIMEOUT_MS, becomes a SetupError. */
export async function setup<T>(step: string, fn: () => Promise<T> | T, timeoutMs = SETUP_TIMEOUT_MS): Promise<T> {
  mark('start', step);
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still running after ${timeoutMs} ms`)), timeoutMs);
    });
    return await Promise.race([Promise.resolve().then(fn), deadline]);
  } catch (e) {
    throw e instanceof SetupError ? e : new SetupError(step, e);
  } finally {
    clearTimeout(timer);
    mark('end', step);
  }
}

export function rawDir(): string {
  return process.env.CONFORMANCE_RAW_DIR ?? join(ROOT, 'results-local', 'raw');
}

function record(r: RawResult) {
  const dir = rawDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${process.pid}.jsonl`), `${JSON.stringify(r)}\n`);
}

/**
 * Trim evidence to the 4 KiB limit (UTF-8 bytes of its JSON) by halving its
 * longest top-level string fields. Nested objects aren't trimmed field by
 * field: if strings can't bring it under, the evidence becomes {truncated: true}.
 */
export function capEvidence(e: Record<string, unknown>): Record<string, unknown> {
  let out = { ...e };
  while (Buffer.byteLength(JSON.stringify(out)) > EVIDENCE_LIMIT) {
    const [k, v] = Object.entries(out)
      .filter(([, v]) => typeof v === 'string')
      .sort((a, b) => (b[1] as string).length - (a[1] as string).length)[0] ?? [];
    if (!k || (v as string).length < 32) return { truncated: true };
    out = { ...out, [k]: `${(v as string).slice(0, Math.floor((v as string).length / 2))}…` };
  }
  return out;
}

/** Thrown when an assertion outlasts ASSERTION_DEADLINE_MS, after its result is recorded. */
export class DeadlineExceeded extends Error {}

/**
 * Run one applicable assertion and record its result. Past `deadlineMs` it
 * records at once: `error` if a setup step is open (ungraded), else `fail`
 * (the host was too slow). The orphaned fn may finish later, but nothing
 * records it: only the race's winner reaches a record() call. Setup steps are
 * deadlined below this (harness/timeouts.ts), and this below Vitest's timeout.
 */
export function runAssertion<C>(id: string, suite: string, ctx: C, fn: (ctx: C) => Promise<void | string>, deadlineMs = ASSERTION_DEADLINE_MS): Promise<void> {
  return current.run(id, async () => {
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const step = openSteps.get(id)?.at(-1);
        const message = step
          ? `ran past ${deadlineMs} ms during setup step ${step}`
          : `ran past ${deadlineMs} ms with no setup step open`;
        record({ id, suite, status: step ? 'error' : 'fail', ms: Date.now() - start, message, ...(step ? { evidence: { step } } : {}) });
        reject(new DeadlineExceeded(message));
      }, deadlineMs);
    });
    try {
      const observed = await Promise.race([fn(ctx), deadline]);
      record({ id, suite, status: 'pass', ms: Date.now() - start, ...(observed ? { message: observed } : {}) });
    } catch (e) {
      if (e instanceof DeadlineExceeded) throw e;
      if (e instanceof Pending) {
        record({ id, suite, status: 'skip', skip_reason: e.message });
        throw e;
      }
      const ms = Date.now() - start;
      const err = e as Error & { evidence?: Record<string, unknown> };
      const status = e instanceof SetupError ? 'error' : 'fail';
      const evidence = err.evidence ?? (e instanceof SetupError ? { step: e.step } : undefined);
      record({ id, suite, status, ms, message: err.message.slice(0, 500), evidence: evidence && capEvidence(evidence) });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });
}

/** fn may return a string: the observation, recorded as the result message (how info rows report). */
export function assertion(id: string, fn: (ctx: RunContext) => Promise<void | string>) {
  test(id, async (t) => {
    const ctx = await runContext();
    const a = ctx.byId.get(id);
    if (!a) {
      const row = ctx.catalogue.assertions.find((x) => x.id === id);
      if (!row) throw new Error(`${id} is not in the catalogue`);
      // A row of another revision: it isn't graded in this run.
      const reason = `not in revision ${ctx.revision}`;
      record({ id, suite: row.suite, status: 'skip', skip_reason: reason });
      t.skip(reason);
      return;
    }
    const reason = notApplicable(a, ctx.manifest);
    if (reason) {
      record({ id, suite: a.suite, status: 'skip', skip_reason: reason });
      t.skip(reason);
      return;
    }
    try {
      await runAssertion(id, a.suite, ctx, fn);
    } catch (e) {
      if (e instanceof Pending) return t.skip(e.message);
      throw e;
    }
  });
}
