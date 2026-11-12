-- HappyView bootstrap: ungraded setup, recorded as setup_mode.bootstrap.
-- Applied once /health answers (migrations have run). Spaces are switched on
-- by FEATURE_SPACES_ENABLED in compose.yml; this only registers the
-- harness's API client, which has no env path.
-- psql variables: client_id (loopback OAuth client id), scopes, secret.

-- The harness's API client. A loopback client id, so no metadata document
-- has to be hosted: pds.js generates it from the id's query.
INSERT INTO happyview_api_clients
  (id, client_key, name, client_id_url, client_uri, redirect_uris, scopes,
   created_by, created_at, updated_at, client_type)
VALUES
  ('conformance-harness', 'hvc_conformance', 'spaces-conformance harness',
   :'client_id', 'http://localhost', '["http://127.0.0.1/callback"]', :'scopes',
   'spaces-conformance', now()::text, now()::text, 'confidential')
ON CONFLICT (id) DO UPDATE SET client_id_url = EXCLUDED.client_id_url, scopes = EXCLUDED.scopes;

INSERT INTO happyview_api_client_secrets (id, client_id, label, secret_hash, created_at)
VALUES ('conformance-harness-secret', 'conformance-harness', 'harness',
        encode(sha256(convert_to(:'secret', 'UTF8')), 'hex'), now()::text)
ON CONFLICT (id) DO NOTHING;
