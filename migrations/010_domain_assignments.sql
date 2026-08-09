CREATE TABLE domain_assignments (
  hostname TEXT PRIMARY KEY COLLATE NOCASE,
  target_type TEXT NOT NULL CHECK(target_type IN ('dashboard','application')),
  app_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'cloudflare' CHECK(provider IN ('cloudflare','manual')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','provisioning','verifying','active','conflict','manual-required','error')),
  zone_id TEXT,
  dns_record_id TEXT,
  tunnel_id TEXT,
  ownership_marker TEXT NOT NULL,
  last_error TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (target_type = 'dashboard' AND app_id IS NULL) OR
    (target_type = 'application' AND app_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX domain_assignments_single_dashboard_idx
  ON domain_assignments(target_type)
  WHERE target_type = 'dashboard';

CREATE INDEX domain_assignments_app_idx
  ON domain_assignments(app_id, hostname);

CREATE INDEX domain_assignments_state_idx
  ON domain_assignments(state, hostname);

INSERT INTO domain_assignments(
  hostname, target_type, app_id, provider, state, zone_id, tunnel_id,
  ownership_marker, last_error, verified_at, created_at, updated_at
)
SELECT
  d.hostname,
  'application',
  d.app_id,
  CASE WHEN s.status = 'external' THEN 'manual' ELSE 'cloudflare' END,
  CASE s.status
    WHEN 'managed' THEN 'active'
    WHEN 'external' THEN 'manual-required'
    WHEN 'error' THEN 'error'
    ELSE 'pending'
  END,
  s.zone_id,
  CASE WHEN s.status = 'managed' THEN c.tunnel_id ELSE NULL END,
  lower(hex(randomblob(16))),
  s.last_error,
  CASE WHEN s.status = 'managed' THEN s.last_synced_at ELSE NULL END,
  d.created_at,
  d.updated_at
FROM application_domains d
LEFT JOIN cloudflare_domain_status s ON s.hostname = d.hostname
LEFT JOIN cloudflare_config c ON c.singleton = 1;

INSERT INTO domain_assignments(
  hostname, target_type, app_id, provider, state, zone_id, tunnel_id,
  ownership_marker, verified_at, created_at, updated_at
)
SELECT
  dashboard_hostname,
  'dashboard',
  NULL,
  'cloudflare',
  CASE WHEN tunnel_id IS NOT NULL THEN 'active' ELSE 'pending' END,
  zone_id,
  tunnel_id,
  lower(hex(randomblob(16))),
  CASE WHEN tunnel_id IS NOT NULL THEN updated_at ELSE NULL END,
  created_at,
  updated_at
FROM cloudflare_config
WHERE singleton = 1 AND dashboard_hostname IS NOT NULL;
