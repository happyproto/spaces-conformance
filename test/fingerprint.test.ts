import { describe, expect, it } from 'vitest';
import { codeInputs, scenarioFingerprint } from '../harness/fingerprint.ts';

describe('scenario fingerprints', () => {
  it('cover the implementation and its partner, and leave deviation lists out', () => {
    const inputs = codeInputs(['happyview', 'pdsjs'], '98ef3a6b9d1364f0543f137dd024de9651b21c4c');
    expect(inputs).toContain('implementations/happyview/manifest.yaml');
    expect(inputs).toContain('implementations/pdsjs/compose.yml');
    expect(inputs).toContain('suites/fixtures.ts');
    expect(inputs.some((p) => p.startsWith('spec/lexicons/98ef3a6b/'))).toBe(true);
    expect(inputs.some((p) => p.startsWith('spec/lexicons/d4def6e9/'))).toBe(false);
    expect(inputs.some((p) => p.endsWith('deviations.yaml'))).toBe(false);
    expect(inputs.some((p) => p.startsWith('implementations/zds/'))).toBe(false);
    expect(inputs.some((p) => p.startsWith('vectors/'))).toBe(false);
  });

  it('are stable, and change with the image, the revision and --slow', () => {
    const a = scenarioFingerprint('zds', { slow: true });
    expect(scenarioFingerprint('zds', { slow: true })).toEqual(a);
    expect(scenarioFingerprint('zds', { slow: false }).digest).not.toBe(a.digest);
    expect(scenarioFingerprint('zds', { slow: true, revision: '2026-10-29' }).digest).not.toBe(a.digest);
    const other = scenarioFingerprint('zds', { slow: true, image: `ghcr.io/happyproto/pds-test/zds@sha256:${'0'.repeat(64)}` });
    expect(other.digest).not.toBe(a.digest);
    expect(other.code).toBe(a.code);
  });

  it('include the partner image for an implementation that has one', () => {
    expect(Object.keys(scenarioFingerprint('happyview', { slow: true }).images).sort()).toEqual(['happyview', 'pdsjs', 'plc']);
  });
});
