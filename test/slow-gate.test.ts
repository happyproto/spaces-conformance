import { describe, expect, it } from 'vitest';
import { AssertionFailure, fail, slowGate } from '../harness/assert.ts';

describe('the --slow gate on needs_slow rows', () => {
  const passes = async () => undefined;
  const fails = async () => fail('broken');
  it('turns a pass into pending without --slow, and leaves it alone with it', async () => {
    await expect(slowGate({ needs_slow: true }, passes, false)(undefined)).rejects.toThrow(/pending: needs --slow/);
    await expect(slowGate({ needs_slow: true }, passes, true)(undefined)).resolves.toBeUndefined();
    await expect(slowGate({}, passes, false)(undefined)).resolves.toBeUndefined();
  });
  it('keeps a fail a fail', async () => {
    await expect(slowGate({ needs_slow: true }, fails, false)(undefined)).rejects.toThrow(AssertionFailure);
  });
});
