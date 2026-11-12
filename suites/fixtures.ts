// Shared per-worker setup for the suites: one owner account and one space,
// created through the adapter (ungraded).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account } from '../harness/adapter.ts';
import type { RunContext } from '../harness/context.ts';
import { ROOT } from '../harness/schema.ts';

export const SPACE_TYPE = 'com.example.conformance.space';
export const COLLECTION = 'com.example.conformance.note';

export interface Fixture {
  owner: Account;
  space: string;
}

let fixture: Promise<Fixture> | undefined;

export function ownerSpace(ctx: RunContext): Promise<Fixture> {
  fixture ??= (async () => {
    const owner = await ctx.adapter.provisionAccount(ctx, 'alice');
    const space = await ctx.adapter.createSpace(ctx, owner, SPACE_TYPE, { $type: 'com.atproto.memberspace.policy', publicRead: false });
    return { owner, space };
  })();
  return fixture;
}

let member: Promise<Account> | undefined;

/** A second account on the same implementation (for pds.js, its own container). */
export function memberAccount(ctx: RunContext): Promise<Account> {
  member ??= ctx.adapter.provisionAccount(ctx, 'bob');
  return member;
}

export const records = (name: 'plain' | 'typed'): { name: string; record: Record<string, unknown> }[] =>
  JSON.parse(readFileSync(join(ROOT, 'fixtures', 'records', `${name}.json`), 'utf8')).records;

export const xrpcUrl = (base: string, nsid: string, params?: Record<string, string>) =>
  `${base}/xrpc/${nsid}${params ? `?${new URLSearchParams(params)}` : ''}`;
