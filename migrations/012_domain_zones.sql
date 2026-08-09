CREATE TABLE domain_zones (
  apex TEXT PRIMARY KEY COLLATE NOCASE,
  cloudflare_zone_id TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('discovered','pending-delegation','active','error')),
  assigned_nameservers TEXT NOT NULL DEFAULT '[]',
  observed_nameservers TEXT NOT NULL DEFAULT '[]',
  original_nameservers TEXT NOT NULL DEFAULT '[]',
  observed_records TEXT NOT NULL DEFAULT '[]',
  original_registrar TEXT,
  inventory_confirmed_at TEXT,
  activated_at TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX domain_zones_state_idx ON domain_zones(state, apex);

ALTER TABLE domain_assignments RENAME TO domain_assignments_legacy;

CREATE TABLE domain_assignments (
  hostname TEXT PRIMARY KEY COLLATE NOCASE,
  apex TEXT NOT NULL COLLATE NOCASE,
  target_type TEXT NOT NULL CHECK(target_type IN ('dashboard','application')),
  app_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'waiting-zone'
    CHECK(state IN ('waiting-zone','provisioning','verifying','active','conflict','error','removing')),
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

INSERT INTO domain_assignments(
  hostname, apex, target_type, app_id, state, zone_id, dns_record_id, tunnel_id,
  ownership_marker, last_error, verified_at, created_at, updated_at
)
SELECT
  hostname,
  hostname,
  target_type,
  app_id,
  CASE state
    WHEN 'active' THEN 'active'
    WHEN 'provisioning' THEN 'provisioning'
    WHEN 'verifying' THEN 'verifying'
    WHEN 'conflict' THEN 'conflict'
    WHEN 'error' THEN 'error'
    WHEN 'removing' THEN 'removing'
    ELSE 'waiting-zone'
  END,
  zone_id,
  dns_record_id,
  tunnel_id,
  ownership_marker,
  last_error,
  verified_at,
  created_at,
  updated_at
FROM domain_assignments_legacy;

DROP TABLE domain_assignments_legacy;

CREATE UNIQUE INDEX domain_assignments_single_dashboard_idx
  ON domain_assignments(target_type)
  WHERE target_type = 'dashboard';

CREATE INDEX domain_assignments_app_idx
  ON domain_assignments(app_id, hostname);

CREATE INDEX domain_assignments_apex_idx
  ON domain_assignments(apex, hostname);

CREATE INDEX domain_assignments_state_idx
  ON domain_assignments(state, hostname);
