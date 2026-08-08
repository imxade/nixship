CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('harbur')),
  base_url TEXT NOT NULL,
  token_encrypted TEXT,
  allow_private_network INTEGER NOT NULL DEFAULT 0 CHECK(allow_private_network IN (0,1)),
  event_cursor INTEGER NOT NULL DEFAULT 0 CHECK(event_cursor >= 0),
  status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','error')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, base_url)
);

ALTER TABLE applications
  ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'github'
  CHECK(source_provider IN ('github','harbur'));

ALTER TABLE applications
  ADD COLUMN source_repository_id TEXT;

ALTER TABLE applications
  ADD COLUMN source_connection_id TEXT REFERENCES integration_connections(id) ON DELETE RESTRICT;

CREATE INDEX applications_source_idx
  ON applications(source_provider, source_connection_id, source_repository_id);
