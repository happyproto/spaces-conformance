-- HAP-408 spike 1 bootstrap (setup, ungraded). TODO(HAP-415): replace the
-- feature flag row with HappyView's env var for spaces once it ships.
-- Runs after HappyView's migrations, i.e. once /health answers.
INSERT INTO happyview_instance_settings (key, value)
VALUES ('feature.spaces_enabled', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

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
