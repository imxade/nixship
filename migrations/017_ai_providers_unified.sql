PRAGMA foreign_keys = OFF;

CREATE TABLE ai_provider_configs_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT,
  api_key_ciphertext TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  allow_private_network INTEGER NOT NULL DEFAULT 0 CHECK(allow_private_network IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO ai_provider_configs_new(
  id, type, name, base_url, api_key_ciphertext, enabled, allow_private_network, metadata_json, created_at, updated_at
)
SELECT id, type, name, base_url, api_key_ciphertext, enabled, allow_private_network, metadata_json, created_at, updated_at
FROM ai_provider_configs;

DROP TABLE ai_provider_configs;

ALTER TABLE ai_provider_configs_new RENAME TO ai_provider_configs;

PRAGMA foreign_keys = ON;
