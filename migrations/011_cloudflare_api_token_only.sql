DROP TABLE cloudflare_oauth_pending;
DROP TABLE cloudflare_oauth_sessions;

ALTER TABLE cloudflare_config RENAME TO cloudflare_config_legacy;

CREATE TABLE cloudflare_config (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  account_id TEXT NOT NULL,
  api_token_encrypted TEXT NOT NULL,
  tunnel_id TEXT,
  tunnel_name TEXT NOT NULL,
  tunnel_token_encrypted TEXT,
  dashboard_hostname TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO cloudflare_config(
  singleton, account_id, api_token_encrypted, tunnel_id, tunnel_name,
  tunnel_token_encrypted, dashboard_hostname, enabled, created_at, updated_at
)
SELECT
  singleton, account_id, api_token_encrypted, tunnel_id,
  COALESCE(tunnel_name, 'nixship'), tunnel_token_encrypted,
  dashboard_hostname, enabled, created_at, updated_at
FROM cloudflare_config_legacy
WHERE auth_method = 'api_token';

DELETE FROM domain_assignments
WHERE target_type = 'dashboard'
  AND hostname NOT IN (
    SELECT dashboard_hostname
    FROM cloudflare_config
    WHERE dashboard_hostname IS NOT NULL
  );

DROP TABLE cloudflare_config_legacy;
