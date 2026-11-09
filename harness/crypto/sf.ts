// RFC 9651 Structured Field Dictionaries, as far as the space headers need:
// bare items that are strings, tokens, integers, booleans or byte sequences,
// with parameters ignored. Strict: anything else is a parse error.

import { b64, fromB64 } from './bytes.ts';

export type SfItem = string | number | boolean | Uint8Array | { token: string };
export type SfDictionary = Map<string, SfItem>;

const KEY = /^[a-z*][a-z0-9_.*-]*/;

export function parseDictionary(input: string): SfDictionary {
  const s = input.trim();
  const out: SfDictionary = new Map();
  let i = 0;
  const fail = (m: string): never => {
    throw new Error(`structured field: ${m} at ${i} in ${JSON.stringify(input)}`);
  };
  const ws = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  while (i < s.length) {
    const k = KEY.exec(s.slice(i));
    if (!k) fail('expected a key');
    const key = k![0];
    i += key.length;
    let value: SfItem = true;
    if (s[i] === '=') {
      i++;
      value = parseItem();
    }
    while (s[i] === ';') {
      i++; // parameters: skipped, but must be well-formed
      const pk = KEY.exec(s.slice(i));
      if (!pk) fail('bad parameter');
      i += pk![0].length;
      if (s[i] === '=') {
        i++;
        parseItem();
      }
    }
    out.set(key, value);
    ws();
    if (i >= s.length) break;
    if (s[i] !== ',') fail('expected ","');
    i++;
    ws();
    if (i >= s.length) fail('trailing comma');
  }
  return out;

  function parseItem(): SfItem {
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

export function serializeDictionary(entries: [string, SfItem][]): string {
  return entries
    .map(([k, v]) => {
      if (v === true) return k;
      if (typeof v === 'string') return `${k}="${v.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
      if (typeof v === 'number') return `${k}=${v}`;
      if (v === false) return `${k}=?0`;
      if (v instanceof Uint8Array) return `${k}=:${b64(v)}:`;
      return `${k}=${v.token}`;
    })
    .join(', ');
}
