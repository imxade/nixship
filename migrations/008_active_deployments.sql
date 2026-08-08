ALTER TABLE quick_tunnels RENAME TO quick_tunnels_legacy;

CREATE TABLE quick_tunnels (
  key TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('dashboard', 'deployment')),
  app_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  deployment_id TEXT REFERENCES deployments(id) ON DELETE CASCADE,
  local_port INTEGER NOT NULL CHECK(local_port BETWEEN 1 AND 65535),
  url TEXT,
  status TEXT NOT NULL CHECK(status IN ('starting', 'running', 'error')),
  pid INTEGER,
  process_group_id INTEGER,
  process_start_ticks TEXT,
  process_command_hash TEXT,
  process_command_summary TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK(
    (target_type = 'dashboard' AND app_id IS NULL AND deployment_id IS NULL AND key = 'dashboard') OR
    (target_type = 'deployment' AND app_id IS NOT NULL AND deployment_id IS NOT NULL
      AND key = 'deployment:' || deployment_id)
  )
);

INSERT INTO quick_tunnels(
  key, target_type, app_id, deployment_id, local_port, url, status, pid,
  process_group_id, process_start_ticks, process_command_hash,
  process_command_summary, failure_count, next_retry_at, last_error,
  started_at, updated_at
)
SELECT
  key, 'dashboard', NULL, NULL, local_port, url, status, pid,
  process_group_id, process_start_ticks, process_command_hash,
  process_command_summary, failure_count, next_retry_at, last_error,
  started_at, updated_at
FROM quick_tunnels_legacy
WHERE key = 'dashboard';

-- Keep the old process identity long enough for the controller to stop the
-- application-level tunnel safely before replacing it with a deployment-level
-- tunnel that targets the deployment's private port.
INSERT INTO quick_tunnels(
  key, target_type, app_id, deployment_id, local_port, url, status, pid,
  process_group_id, process_start_ticks, process_command_hash,
  process_command_summary, failure_count, next_retry_at, last_error,
  started_at, updated_at
)
SELECT
  'deployment:' || a.active_deployment_id, 'deployment', q.app_id,
  a.active_deployment_id, q.local_port, q.url, q.status, q.pid,
  q.process_group_id, q.process_start_ticks, q.process_command_hash,
  q.process_command_summary, q.failure_count, q.next_retry_at, q.last_error,
  q.started_at, q.updated_at
FROM quick_tunnels_legacy q
JOIN applications a ON a.id = q.app_id
JOIN deployments d ON d.id = a.active_deployment_id
WHERE q.target_type = 'application'
  AND d.state = 'running'
  AND d.internal_port IS NOT NULL;

DROP TABLE quick_tunnels_legacy;

CREATE UNIQUE INDEX quick_tunnels_deployment_idx
  ON quick_tunnels(deployment_id)
  WHERE deployment_id IS NOT NULL;

CREATE INDEX quick_tunnels_app_idx
  ON quick_tunnels(app_id)
  WHERE app_id IS NOT NULL;

INSERT INTO settings(key, value, updated_at)
VALUES ('active_deployment_limit', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO NOTHING;
