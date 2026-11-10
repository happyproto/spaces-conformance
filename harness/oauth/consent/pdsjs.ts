// pds.js headless consent: its authorize form takes the account password and,
// with Accept: application/json, answers the redirect as JSON.

import { http } from '../../http.ts';
import type { AuthServer, Consent } from '../client.ts';

export function pdsjsConsent(password: string): Consent {
  return {
    async approve(as: AuthServer, { requestUri, clientId }) {
      const r = await http(as.authorization_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ request_uri: requestUri, client_id: clientId, password, action: 'approve' }).toString(),
      });
      if (r.status >= 300 || typeof r.body?.redirect !== 'string') {
        throw new Error(`pds.js consent refused (${r.status}): ${JSON.stringify(r.body)}`);
      }
      return r.body.redirect;
    },
  };
}
