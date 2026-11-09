// Registering an OAuth token set with a host that runs the user's session for
// an app (HappyView's API-client flow: POST /oauth/sessions).
//
// The registered scope is always the scope the authorization server granted
// (TokenSet.scope), with no way for a caller to substitute another. That way
// the scope assertions test the host's gate against what the AS granted.

import type { TokenSet } from './client.ts';

export interface SessionRegistration {
  provision_id: string;
  did: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scopes: string;
  issuer: string;
}

/**
 * The /oauth/sessions body for `tokens`. It takes no scope argument on
 * purpose, and `did` must be the token's own subject.
 */
export function sessionRegistration(provisionId: string, tokens: TokenSet): SessionRegistration {
  if (!tokens.sub) throw new Error('token set has no subject');
  if (!tokens.scope.split(' ').includes('atproto')) throw new Error(`granted scope ${JSON.stringify(tokens.scope)} lacks atproto`);
  return {
    provision_id: provisionId,
    did: tokens.sub,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: tokens.expiresAt,
    scopes: tokens.scope,
    issuer: tokens.issuer,
  };
}
