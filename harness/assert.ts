// Declaring a test for an assertion. Each `assertion(id, fn)` becomes one
// Vitest test, and records one raw result (pass, fail, error or skip) to
// the run's raw directory, which the reporter assembles into the results file.
//
//   - Not applicable by role, profile or capability: skip, with the reason.
//   - A throw from setup(), or from anything before fn's own checks: error.
//   - A failed check (fail(), or a Vitest expect): fail, with evidence.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { type RunContext, runContext } from './context.ts';
import { notApplicable } from './manifest.ts';
import { EVIDENCE_LIMIT } from './results.ts';
import { ROOT } from './schema.ts';

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

/** Run a setup step; any throw becomes a SetupError. */
export async function setup<T>(step: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof SetupError ? e : new SetupError(step, e);
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

/** Trim evidence to the 4 KiB limit by shortening its longest string fields. */
export function capEvidence(e: Record<string, unknown>): Record<string, unknown> {
  let out = { ...e };
  while (JSON.stringify(out).length > EVIDENCE_LIMIT) {
    const [k, v] = Object.entries(out)
      .filter(([, v]) => typeof v === 'string')
      .sort((a, b) => (b[1] as string).length - (a[1] as string).length)[0] ?? [];
    if (!k || (v as string).length < 32) return { truncated: true };
    out = { ...out, [k]: `${(v as string).slice(0, Math.floor((v as string).length / 2))}…` };
  }
  return out;
}

/** fn may return a string: the observation, recorded as the result message (how info rows report). */
export function assertion(id: string, fn: (ctx: RunContext) => Promise<void | string>) {
  test(id, async (t) => {
    const ctx = await runContext();
    const a = ctx.byId.get(id);
    if (!a) throw new Error(`${id} is not in the catalogue`);
    const reason = notApplicable(a, ctx.manifest);
    if (reason) {
      record({ id, suite: a.suite, status: 'skip', skip_reason: reason });
      t.skip(reason);
      return;
    }
    const start = Date.now();
    try {
      const observed = await fn(ctx);
      record({ id, suite: a.suite, status: 'pass', ms: Date.now() - start, ...(observed ? { message: observed } : {}) });
    } catch (e) {
      const ms = Date.now() - start;
      const err = e as Error & { evidence?: Record<string, unknown> };
      const status = e instanceof SetupError ? 'error' : 'fail';
      const evidence = err.evidence ?? (e instanceof SetupError ? { step: e.step } : undefined);
      record({ id, suite: a.suite, status, ms, message: err.message.slice(0, 500), evidence: evidence && capEvidence(evidence) });
      throw e;
    }
  });
}
