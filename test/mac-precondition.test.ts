import { describe, expect, it } from 'vitest';
import { Pending } from '../harness/assert.ts';
import { generate } from '../harness/crypto/keys.ts';
import { NO_KEM, requireAuthorKem, requireMacHeader } from '../suites/mac/precondition.ts';

const target = { repoHost: 'https://h.test', space: 'at://did:plc:s/space/a.b.c/self', repo: 'did:plc:a' };

describe('MAC row preconditions', () => {
  it('skips, pending, when the author publishes no #atproto_kem key: kem-key-published grades that once', () => {
    expect(() => requireAuthorKem(target)).toThrow(Pending);
    expect(() => requireAuthorKem(target)).toThrow(`pending: ${NO_KEM}`);
    const key = generate('p256');
    expect(requireAuthorKem({ ...target, authorKem: key })).toBe(key);
  });

  it('skips, pending, when a session read carries no MAC, and passes a present header through', () => {
    expect(() => requireMacHeader({ present: false, verified: false, vary: false })).toThrow(Pending);
    expect(requireMacHeader({ present: true, verified: false, vary: true, header: 'h' })).toBe('h');
  });
});
