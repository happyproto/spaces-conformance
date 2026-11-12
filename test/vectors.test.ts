// Runs vectors/*.json against the harness's own crypto (design ch. 3.4), plus
// the negative cases each format's rules require.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { p256 } from '@noble/curves/nist.js';
import { describe, expect, it } from 'vitest';
import { concat, fromB64url, fromHex, hex, lenPrefixed, utf8, varint } from '../harness/crypto/bytes.ts';
import { Cid, CODEC_RAW } from '../harness/crypto/cid.ts';
import { decode, encode, fromLexJson, recordCid, toLexJson } from '../harness/crypto/drisl.ts';
import { presentCredential, signatureBase, toHighS, verifyPresentation } from '../harness/crypto/httpsig.ts';
import { decodeJwt, signJwt, verifyJwt } from '../harness/crypto/jwt.ts';
import { deriveSharedSecret, ecdhX, hostSharedSecret, syncerSharedSecret } from '../harness/crypto/kem.ts';
import { didKey, fromSecret, generate, parseDidKey, parseMultikey, multikey } from '../harness/crypto/keys.ts';
import { EMPTY_DIGEST_HEX, LtHash } from '../harness/crypto/lthash.ts';
import { commitMac, macHeader, parseMacHeader, parseWantMac, recordMac, wantMacHeader } from '../harness/crypto/mac.ts';
import { checkSpaceRepo, MAGIC, pathKey, readStar, writeStar } from '../harness/crypto/star.ts';
import { ROOT } from '../harness/schema.ts';

const vec = (name: string) => JSON.parse(readFileSync(join(ROOT, 'vectors', `${name}.json`), 'utf8'));

describe('LtHash', () => {
  const v = vec('lthash');
  it.each((v.vectors as any[]).map((x: any): [string, any] => [x.name, x]))('%s', (_n, x: any) => {
    const h = new LtHash();
    for (const e of x.elements ?? []) h.add(utf8(e));
    for (const r of x.records ?? []) h.add(LtHash.element(r.collection, r.rkey, r.cid));
    expect(hex(h.digest())).toBe(x.digest);
  });
  it('matches the spec constant when empty, is order independent, and removal undoes addition', () => {
    expect(hex(new LtHash().digest())).toBe(EMPTY_DIGEST_HEX);
    const a = LtHash.element('c.x.y', 'a', 'bafy1');
    const b = LtHash.element('c.x.y', 'b', 'bafy2');
    expect(hex(new LtHash().add(a).add(b).digest())).toBe(hex(new LtHash().add(b).add(a).digest()));
    expect(hex(new LtHash().add(a).add(b).remove(b).digest())).toBe(hex(new LtHash().add(a).digest()));
    expect(hex(new LtHash().add(a).remove(a).digest())).toBe(EMPTY_DIGEST_HEX);
  });
});

describe('DRISL and CIDs', () => {
  const v = vec('cid');
  it.each((v.vectors as any[]).map((x: any): [string, any] => [x.name, x]))('record %s', (_n, x: any) => {
    expect(recordCid(x.record).toString()).toBe(x.cid);
    // Round trip: canonical bytes decode and re-encode to themselves.
    const bytes = encode(fromLexJson(x.record));
    expect(hex(encode(decode(bytes)))).toBe(hex(bytes));
    expect(toLexJson(decode(bytes))).toEqual(x.record);
  });
  it.each((v.raw as any[]).map((x: any): [string, any] => [x.name, x]))('raw %s', (_n, x: any) => {
    expect(Cid.of(CODEC_RAW, fromHex(x.bytes_hex)).toString()).toBe(x.cid);
  });
  it('parses and prints CIDs', () => {
    const s = v.vectors[0].cid;
    expect(Cid.parse(s).toString()).toBe(s);
  });
  it.each([
    ['indefinite map', 'bf ff'],
    ['non-minimal integer', 'a1 61 61 18 01'],
    ['unsorted keys', 'a2 61 62 01 61 61 02'],
    ['length-first violated', 'a2 62 61 61 01 61 62 02'],
    ['duplicate key', 'a2 61 61 01 61 61 02'],
    ['non-string key', 'a1 01 02'],
    ['other tag', 'c1 00'],
    ['undefined', 'f7'],
    ['half float', 'f9 3c 00'],
    ['trailing bytes', 'a0 00'],
    ['truncated string', '63 61 62'],
  ])('rejects %s', (_n, h) => {
    expect(() => decode(fromHex(h.replace(/ /g, '')))).toThrow();
  });
  it('caps nesting depth', () => {
    const deep = new Uint8Array(200).fill(0x81); // 200 nested one-element arrays
    expect(() => decode(concat(deep, new Uint8Array([0x00])))).toThrow(/deeper/);
  });
  it('keeps a BOM in a string instead of stripping it', () => {
    expect(decode(fromHex('64efbbbf41'))).toBe('\ufeffA');
  });
  it('refuses floats when asked, as records must', () => {
    const f = fromHex('a16166fb3ff8000000000000');
    expect(decode(f)).toEqual({ f: 1.5 });
    expect(() => decode(f, { noFloats: true })).toThrow(/floats/);
  });
  it('refuses floats and unsafe numbers when encoding', () => {
    expect(() => encode({ f: 1.5 })).toThrow();
    expect(() => encode({ f: 2 ** 53 })).toThrow();
  });
});

describe('keys', () => {
  it('round trips P-256 and secp256k1 did:keys', () => {
    for (const curve of ['p256', 'secp256k1'] as const) {
      const k = generate(curve);
      const p = parseDidKey(didKey(k));
      expect(p.curve).toBe(curve);
      expect(hex(p.compressed)).toBe(hex(k.compressed));
      expect(parseMultikey(multikey(k)).curve).toBe(curve);
    }
    expect(didKey(generate('p256')).startsWith('did:key:zDna')).toBe(true);
  });
});

describe('KEM shared secret', () => {
  const [x] = vec('kem').vectors;
  it(x.name, () => {
    const author = fromSecret('p256', fromHex(x.skRm));
    const pkEm = { curve: 'p256' as const, compressed: p256.Point.fromBytes(fromHex(x.pkEm)).toBytes(true) };
    expect(hex(hostSharedSecret(author, pkEm))).toBe(x.shared_secret);
  });
  it.each((vec('kem').negative as any[]).map((n: any): [string, any] => [n.name, n]))('negative: %s', (_n, n: any) => {
    const author = fromSecret('p256', fromHex(n.skRm));
    const pkEm = { curve: 'p256' as const, compressed: p256.Point.fromBytes(fromHex(n.pkEm)).toBytes(true) };
    expect(hex(hostSharedSecret(author, pkEm))).not.toBe(n.not_shared_secret);
  });
  it('agrees between syncer and host, and differs for another author key', () => {
    const author = generate('p256');
    const eph = generate('p256');
    const ss = syncerSharedSecret(eph, author);
    expect(hex(hostSharedSecret(author, eph))).toBe(hex(ss));
    expect(hex(hostSharedSecret(generate('p256'), eph))).not.toBe(hex(ss));
    expect(hex(deriveSharedSecret(ecdhX(eph.secret, author), eph, author))).toBe(hex(ss));
  });
});

describe('MACs', () => {
  const v = vec('mac');
  const ss = fromHex(v.shared_secret);
  const nodeHmac = (data: Uint8Array) => createHmac('sha256', ss).update(data).digest('hex');
  it.each((v.commit as any[]).map((x: any): [string, any] => [x.name, x]))('commit %s', (_n, x: any) => {
    const mac = hex(commitMac(ss, { ver: x.ver, space: x.space, repo: x.repo, rev: x.rev, data: fromHex(x.data) }));
    expect(mac).toBe(x.mac);
    const context = concat(utf8(`atproto-space-repo-v${x.ver}`), lenPrefixed(x.space), lenPrefixed(x.repo), lenPrefixed(x.rev));
    expect(nodeHmac(concat(context, fromHex(x.data)))).toBe(x.mac);
  });
  it.each((v.record as any[]).map((x: any): [string, any] => [x.name, x]))('record %s', (_n, x: any) => {
    const cid = Cid.parse(x.cid);
    expect(hex(recordMac(ss, x.uri, cid.bytes))).toBe(x.mac);
    expect(nodeHmac(concat(utf8('atproto-space-record-v1'), lenPrefixed(x.uri), cid.bytes))).toBe(x.mac);
  });
  it('round trips the Want-Mac and Mac headers', () => {
    const k = generate('p256');
    const w = parseWantMac(wantMacHeader('atproto-space-repo', 1, k));
    expect([w.type, w.ver, hex(w.keyShare.compressed)]).toEqual(['atproto-space-repo', 1, hex(k.compressed)]);
    const mac = new Uint8Array(32).fill(7);
    expect(hex(parseMacHeader(macHeader('atproto-space-repo', 1, mac)).mac)).toBe(hex(mac));
    expect(parseMacHeader('type="atproto-space-repo", ver=1, mac=:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=:').mac[31]).toBe(31);
  });
  it.each([
    ['no key_share', 'type="atproto-space-repo", ver=1'],
    ['secp256k1 key_share', () => `type="atproto-space-repo", ver=1, key_share="${didKey(generate('secp256k1'))}"`],
    ['ver as string', 'type="atproto-space-repo", ver="1", key_share="did:key:zDnae"'],
    ['garbage', 'type=='],
  ])('rejects a Want-Mac with %s', (_n, h) => {
    expect(() => parseWantMac(typeof h === 'function' ? h() : h)).toThrow();
  });
  it('matches the HMAC input written out from the spec layout', () => {
    const x = v.commit[0];
    const context = concat(utf8(`atproto-space-repo-v${x.ver}`), lenPrefixed(x.space), lenPrefixed(x.repo), lenPrefixed(x.rev));
    expect(hex(concat(context, fromHex(x.data)))).toBe(x.hmac_input);
  });
  it.each((v.negative as any[]).map((x: any): [string, any] => [x.name, x]))('negative: %s does not verify', (_n, x: any) => {
    const got =
      x.kind === 'commit'
        ? commitMac(ss, { ver: x.ver, space: x.space, repo: x.repo, rev: x.rev, data: fromHex(x.data) })
        : recordMac(ss, x.uri, Cid.parse(x.cid).bytes);
    expect(hex(got)).not.toBe(x.mac);
  });
  it('rejects a Mac header whose mac is not 32 bytes', () => {
    expect(() => parseMacHeader('type="atproto-space-repo", ver=1, mac=:AAEC:')).toThrow();
  });
});

describe('HTTP message signatures', () => {
  const [x] = vec('httpsig').vectors;
  it('builds the signature base and input the spec shows', () => {
    expect(signatureBase({ authorization: x.authorization, 'atproto-space-audience': x.audience }, ['authorization', 'atproto-space-audience'], 'atproto-space-credential')).toBe(x.base);
    const h = presentCredential('credential', x.audience, generate('p256'));
    expect(h['signature-input']).toBe(x.signature_input);
    expect(h.authorization).toBe(x.authorization);
  });
  it('verifies a good presentation, including high-S and a lowercase scheme', () => {
    const k = generate('p256');
    expect(verifyPresentation(presentCredential('jwt', 'did:plc:repo', k), k)).toBeNull();
    expect(verifyPresentation(presentCredential('jwt', 'did:plc:repo', k, { highS: true }), k)).toBeNull();
    expect(verifyPresentation(presentCredential('jwt', 'did:plc:repo', k, { scheme: 'atproto-space-credential' }), k)).toBeNull();
  });
  it('produces a genuinely high-S signature', () => {
    const k = generate('p256');
    const sig = p256.sign(utf8('m'), k.secret, { lowS: true });
    const hs = toHighS(sig);
    expect(p256.verify(hs, utf8('m'), k.compressed, { lowS: true })).toBe(false);
    expect(p256.verify(hs, utf8('m'), k.compressed, { lowS: false })).toBe(true);
  });
  it.each([
    ['no signature', { omitSignature: true }],
    ['wrong components', { components: ['authorization'] }],
    ['wrong order', { components: ['atproto-space-audience', 'authorization'] }],
    ['wrong tag', { tag: 'nope' }],
    ['another audience signed', { signedAudience: 'did:plc:other' }],
    ['another signer', { signer: generate('p256') }],
  ])('refuses %s', (_n, o) => {
    const k = generate('p256');
    expect(verifyPresentation(presentCredential('jwt', 'did:plc:repo', k, o as any), k)).not.toBeNull();
  });
  it('accepts alg and keyid when they are right, and refuses them when wrong', () => {
    const k = generate('p256');
    const ok = `;alg="ecdsa-p256-sha256";keyid="${didKey(k)}"`;
    expect(verifyPresentation(presentCredential('jwt', 'did:plc:repo', k, { extraParams: ok }), k)).toBeNull();
    expect(verifyPresentation(presentCredential('jwt', 'did:plc:repo', k, { extraParams: ';alg="rsa-pss-sha512"' }), k)).toBe('wrong alg');
    expect(verifyPresentation(presentCredential('jwt', 'did:plc:repo', k, { extraParams: `;keyid="${didKey(generate('p256'))}"` }), k)).toBe('keyid is not cnf.kid');
  });
  it('parses inner lists with parameters and rebuilds them exactly', async () => {
    const { parseDictionary, serializeInnerList, isInnerList } = await import('../harness/crypto/sf.ts');
    const v = parseDictionary('sig1=("a" "b");tag="t";created=1, other=?1').get('sig1');
    expect(isInnerList(v) && serializeInnerList(v)).toBe('("a" "b");tag="t";created=1');
  });
  it('refuses a non-P-256 bound key', () => {
    const k = generate('p256');
    expect(verifyPresentation(presentCredential('jwt', 'did:plc:repo', k), { curve: 'secp256k1', compressed: generate('secp256k1').compressed })).toMatch(/P-256/);
  });
});

describe('fixed-key HTTP signatures', () => {
  const sg = vec('httpsig').signed;
  const k = fromSecret('p256', fromHex(sg.secret));
  it('derives the vector cnf.kid', () => expect(didKey(k)).toBe(sg.cnf_kid));
  it.each((sg.cases as any[]).map((c: any): [string, any] => [c.name, c]))('%s', (_n, c: any) => {
    const headers = { authorization: sg.authorization, 'atproto-space-audience': sg.audience, 'signature-input': c.signature_input, signature: c.signature };
    expect(verifyPresentation(headers, k) === null).toBe(c.expect === 'accept');
  });
  it('reproduces the valid signature deterministically', () => {
    const h = presentCredential('credential', sg.audience, k);
    expect(h.signature).toBe(sg.cases[0].signature);
  });
});

describe('JWT vectors', () => {
  const jv = vec('jwt');
  const keyOf = (jwk: any) => ({ curve: 'p256' as const, compressed: p256.Point.fromBytes(new Uint8Array([4, ...fromB64url(jwk.x), ...fromB64url(jwk.y)])).toBytes(true) });
  it.each((jv.vectors as any[]).map((x: any): [string, any] => [x.name, x]))('%s verifies (high-S accepted)', (_n, x: any) => {
    expect(verifyJwt(decodeJwt(x.jws), keyOf(x.jwk))).toBe(true);
    expect(verifyJwt(decodeJwt(x.jws), keyOf(x.jwk), { lowS: true })).toBe(!x.high_s);
  });
  it.each((jv.negative as any[]).map((x: any): [string, any] => [x.name, x]))('negative: %s', (_n, x: any) => {
    expect(verifyJwt(decodeJwt(x.jws), keyOf(jv.vectors[0].jwk))).toBe(false);
  });
});

describe('JWT', () => {
  it('signs and verifies ES256 and ES256K, and rejects a wrong key or alg', () => {
    for (const curve of ['p256', 'secp256k1'] as const) {
      const k = generate(curve);
      const t = decodeJwt(signJwt({ typ: 'atproto-space-credential+jwt', kid: '#atproto' }, { iss: 'did:plc:x' }, k));
      expect(t.header.alg).toBe(curve === 'p256' ? 'ES256' : 'ES256K');
      expect(verifyJwt(t, k)).toBe(true);
      expect(verifyJwt(t, generate(curve))).toBe(false);
      expect(verifyJwt({ ...t, header: { ...t.header, alg: 'none' } }, k)).toBe(false);
    }
  });
});

describe('STAR', () => {
  const [good] = vec('star').valid;
  const bytes = fromHex(good.hex);
  it('reads the valid archive and its digest matches its metadata', () => {
    const r = checkSpaceRepo(bytes);
    expect(r.records).toHaveLength(good.records);
    expect(hex(r.computed)).toBe(hex(r.meta.data));
    expect(r.records[0].cid).toBe('bafyreiesv7m3kvsm5zvhragkl776ixbkwpwxuqx5vr646rlbou7knizux4');
  });
  const meta = readStar(bytes).meta;
  const rec = encode({ a: 1 });
  const mk = (pairs: [string, Uint8Array][], m = meta) => writeStar(m, pairs.map(([k, v]) => ({ key: utf8(k), value: v })));
  it.each([
    ['bad magic', () => concat(new Uint8Array([0x2a, 0x6c, 0x02, 0x00]), bytes.subarray(4))],
    ['non-canonical meta varint', () => concat(MAGIC, new Uint8Array([0x80 | (bytes[4] & 0x7f), 0x80 | bytes[5], 0x00]), bytes.subarray(6))],
    ['meta that does not fill its length', () => { const m = encode(meta); return concat(MAGIC, varint(m.length + 1), m, new Uint8Array([0x00])); }],
    ['truncation inside a pair', () => bytes.subarray(0, bytes.length - 3)],
    ['a key with no value', () => concat(bytes.subarray(0, bytes.length - 1), new Uint8Array([0x01]), varint(3), utf8('a/b'))],
    ['no end byte', () => bytes.subarray(0, bytes.length - 1)],
    ['bytes after the end byte', () => concat(bytes, new Uint8Array([0x00]))],
    ['out-of-order keys', () => mk([['c.x.y/b', rec], ['c.x.y/a', rec]])],
    ['duplicate keys', () => mk([['c.x.y/a', rec], ['c.x.y/a', rec]])],
    ['a key that is not a record path', () => mk([['not-a-path', rec]])],
    ['a non-canonical record', () => mk([['c.x.y/a', fromHex('a1616118 01'.replace(/ /g, ''))]])],
    ['a record with a float', () => mk([['c.x.y/a', fromHex('a16166fb3ff8000000000000')]])],
    ['a collection that is not an NSID', () => mk([['c.x-.y/a', rec]])],
    ['a two-segment collection', () => mk([['c.y/a', rec]])],
    ['an rkey of ..', () => mk([['c.x.y/..', rec]])],
    ['a record over 1 MiB', () => mk([['c.x.y/a', encode({ b: new Uint8Array(1024 * 1024) })]])],
    ['another $type', () => mk([], { ...meta, $type: 'atproto-space-meta' })],
  ])('rejects %s', (_n, build) => {
    expect(() => checkSpaceRepo(build())).toThrow();
  });
  it('reports a digest mismatch for the caller to reject', () => {
    const r = checkSpaceRepo(mk([['com.example.conformance.note/a', rec]]));
    expect(hex(r.computed)).not.toBe(hex(r.meta.data));
  });
  it('builds keys from collection and rkey', () => {
    expect(hex(pathKey('a.b.c', 'self'))).toBe(hex(utf8('a.b.c/self')));
  });
});

describe('STAR interop fixtures (microcosm.blue/star 41bdec1)', () => {
  const load = (f: string) => JSON.parse(readFileSync(join(ROOT, 'vectors', 'star-interop', f), 'utf8'));
  const valid: { comment: string; star_hex: string; decoded: { meta: Record<string, unknown>; pairs: { key_hex: string; value_hex: string }[] } }[] = load('valid-star-fixtures.json');
  const invalid: { comment: string; star_hex: string }[] = load('invalid-star-fixtures.json');
  it('has every fixture', () => {
    expect(valid).toHaveLength(19);
    expect(invalid).toHaveLength(37);
  });
  it.each(valid.map((f) => [f.comment, f] as const))('reads and rewrites: %s', (_c, f) => {
    const star = fromHex(f.star_hex);
    const got = readStar(star);
    expect(toLexJson(got.meta)).toEqual(f.decoded.meta);
    expect(got.pairs.map((p) => ({ key_hex: hex(p.key), value_hex: hex(p.value) }))).toEqual(f.decoded.pairs.map((p) => ({ key_hex: p.key_hex.toLowerCase(), value_hex: p.value_hex.toLowerCase() })));
    expect(hex(writeStar(got.meta, got.pairs))).toBe(f.star_hex.toLowerCase());
  });
  it.each(invalid.map((f) => [f.comment, f] as const))('rejects: %s', (_c, f) => {
    expect(() => readStar(fromHex(f.star_hex))).toThrow();
  });
});
