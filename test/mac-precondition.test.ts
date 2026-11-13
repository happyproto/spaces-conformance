import { describe, expect, it } from 'vitest';
import { AssertionFailure, Pending } from '../harness/assert.ts';
import { generate } from '../harness/crypto/keys.ts';
import { NO_KEM, requireAuthorKem, requireMac, requireMacHeader } from '../suites/mac/precondition.ts';

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

  it('from 2026-11-12, counts any MAC header as a MAC, so a partial answer is graded rather than skipped', () => {
    expect(() => requireMac({ present: false, verified: false, vary: false })).toThrow(Pending);
    expect(() => requireMac({ present: true, verified: false, vary: false, signature: 'mac=:AA==:' })).not.toThrow();
  });
});

describe('MAC row preconditions on a credential read', () => {
  it('fails, rather than pends, when a credential read carries no MAC', () => {
    const none = { present: false, verified: false, vary: false };
    expect(() => requireMac(none, true)).toThrow(AssertionFailure);
    expect(() => requireMacHeader(none, true)).toThrow(AssertionFailure);
    expect(() => requireMac(none, false)).toThrow(Pending);
  });
});
