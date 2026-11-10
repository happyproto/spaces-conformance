// The harness's HTTP client: the project user-agent, no redirects followed,
// and the response body parsed as JSON when it is JSON.

export const USER_AGENT = 'spaces-conformance (+https://github.com/happyproto/spaces-conformance)';

export interface HttpResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  /** The raw bytes, for binary responses such as STAR archives. */
  bytes: Uint8Array;
}

export async function http<T = any>(url: string, init: RequestInit = {}): Promise<HttpResponse<T>> {
  const headers = new Headers(init.headers);
  headers.set('user-agent', USER_AGENT);
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body: any = undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json') || (bytes.length && (bytes[0] === 0x7b || bytes[0] === 0x5b))) {
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = new TextDecoder().decode(bytes);
    }
  } else if (!type.startsWith('application/') || type.includes('text')) {
    body = new TextDecoder().decode(bytes);
  }
  return { status: res.status, headers: res.headers, body, bytes };
}

export const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const form = (body: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
