// atproto identifier syntax: NSIDs and record keys.

/**
 * An NSID: at least three segments and at most 317 characters. The domain
 * authority segments are 1-63 characters of letters, digits and hyphens, not
 * starting or ending with a hyphen, and the first doesn't start with a digit.
 * The final name segment is 1-63 letters and digits, starting with a letter.
 */
export function isNsid(s: string): boolean {
  if (s.length > 317) return false;
  const parts = s.split('.');
  if (parts.length < 3) return false;
  const name = parts.pop()!;
  if (!/^[a-zA-Z][a-zA-Z0-9]{0,62}$/.test(name)) return false;
  if (parts.join('.').length > 253) return false;
  return parts.every((p, i) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(p) && !(i === 0 && /^[0-9]/.test(p)));
}

/** A record key: 1-512 characters of [A-Za-z0-9._:~-], and not "." or "..". */
export const isRecordKey = (s: string): boolean => /^[A-Za-z0-9._:~-]{1,512}$/.test(s) && s !== '.' && s !== '..';
