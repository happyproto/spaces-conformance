// RFC 9651 Structured Field Dictionaries, as far as the space headers need:
// bare items (strings, tokens, integers, booleans, byte sequences), inner
// lists of bare items, and parameters on both. Strict: anything else is a
// parse error. Parameters are kept in order, so @signature-params can be
// rebuilt exactly.

import { b64, fromB64 } from './bytes.ts';

export type SfBare = string | number | boolean | Uint8Array | { token: string };
export type SfParams = [string, SfBare][];
export interface SfInnerList {
  inner: SfBare[];
  params: SfParams;
  /** Each inner item's own parameters, by position (`"atproto-space-commit";sf`). Absent means none. */
  itemParams?: SfParams[];
}
export type SfItem = SfBare | SfInnerList;
export type SfDictionary = Map<string, SfItem>;
/** Parameters per dictionary member, for members that carry any. */
export type SfMemberParams = Map<string, SfParams>;

const KEY = /^[a-z*][a-z0-9_.*-]*/;

export const isInnerList = (v: SfItem | undefined): v is SfInnerList => typeof v === 'object' && v !== null && 'inner' in v;

export function parseDictionary(input: string, memberParams?: SfMemberParams): SfDictionary {
  const s = input.trim();
  const out: SfDictionary = new Map();
  let i = 0;
  const fail = (m: string): never => {
    throw new Error(`structured field: ${m} at ${i} in ${JSON.stringify(input)}`);
  };
  const ws = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  const key = (): string => {
    const k = KEY.exec(s.slice(i));
    if (!k) fail('expected a key');
    i += k![0].length;
    return k![0];
  };
  const params = (): SfParams => {
    const ps: SfParams = [];
    while (s[i] === ';') {
      i++;
      while (s[i] === ' ') i++;
      const k = key();
      let v: SfBare = true;
      if (s[i] === '=') {
        i++;
        v = bare();
      }
      ps.push([k, v]);
    }
    return ps;
  };

  while (i < s.length) {
    const k = key();
    let value: SfItem = true;
    let ps: SfParams = [];
    if (s[i] === '=') {
      i++;
      if (s[i] === '(') value = innerList();
      else {
        value = bare();
        ps = params();
      }
    } else ps = params();
    out.set(k, value);
    if (ps.length) memberParams?.set(k, ps);
    ws();
    if (i >= s.length) break;
    if (s[i] !== ',') fail('expected ","');
    i++;
    ws();
    if (i >= s.length) fail('trailing comma');
  }
  return out;

  function innerList(): SfInnerList {
    i++; // (
    const inner: SfBare[] = [];
    const itemParams: SfParams[] = [];
    for (;;) {
      while (s[i] === ' ') i++;
      if (s[i] === ')') {
        i++;
        break;
      }
      if (i >= s.length) fail('unterminated inner list');
      inner.push(bare());
      itemParams.push(params());
      if (s[i] !== ' ' && s[i] !== ')') fail('expected " " or ")" in inner list');
    }
    const list: SfInnerList = { inner, params: params() };
    if (itemParams.some((p) => p.length)) list.itemParams = itemParams;
    return list;
  }

  function bare(): SfBare {
    const c = s[i];
    if (c === '"') {
      let str = '';
      i++;
      while (i < s.length) {
        const ch = s[i++];
        if (ch === '\\') {
          const e = s[i++];
          if (e !== '"' && e !== '\\') fail('bad escape');
          str += e;
        } else if (ch === '"') return str;
        else if (ch < ' ' || ch > '~') fail('non-printable in string');
        else str += ch;
      }
      return fail('unterminated string');
    }
    if (c === ':') {
      const end = s.indexOf(':', i + 1);
      if (end < 0) fail('unterminated byte sequence');
      const body = s.slice(i + 1, end);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) fail('bad base64');
      i = end + 1;
      return fromB64(body);
    }
    if (c === '?') {
      const v = s[i + 1];
      if (v !== '0' && v !== '1') fail('bad boolean');
      i += 2;
      return v === '1';
    }
    const num = /^-?[0-9]{1,15}(?![.0-9])/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const tok = /^[A-Za-z*][A-Za-z0-9!#$%&'*+.^_`|~:/-]*/.exec(s.slice(i));
    if (tok) {
      i += tok[0].length;
      return { token: tok[0] };
    }
    return fail('expected an item');
  }
}

export function serializeBare(v: SfBare): string {
  if (v === true) return '?1';
  if (v === false) return '?0';
  if (typeof v === 'string') return `"${v.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
  if (typeof v === 'number') return String(v);
  if (v instanceof Uint8Array) return `:${b64(v)}:`;
  return v.token;
}

export const serializeParams = (ps: SfParams): string => ps.map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serializeBare(v)}`)).join('');

export const serializeInnerList = (l: SfInnerList): string =>
  `(${l.inner.map((v, i) => serializeBare(v) + serializeParams(l.itemParams?.[i] ?? [])).join(' ')})${serializeParams(l.params)}`;

export function serializeDictionary(entries: [string, SfItem][]): string {
  return entries
    .map(([k, v]) => {
      if (v === true) return k;
      if (isInnerList(v)) return `${k}=${serializeInnerList(v)}`;
      return `${k}=${serializeBare(v)}`;
    })
    .join(', ');
}
