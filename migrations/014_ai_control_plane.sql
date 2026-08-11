PRAGMA foreign_keys = ON;

CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('global','app','deployment','integration','ai')),
  scope_id TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ai_conversations_user_updated_idx
  ON ai_conversations(user_id, updated_at DESC);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  kind TEXT NOT NULL CHECK(kind IN ('text','input_request','plan','result','error')),
  content_ciphertext TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_messages_conversation_created_idx
  ON ai_messages(conversation_id, created_at);

CREATE TABLE ai_plans (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN (
    'draft','proposed','rejected','expired','stale','approved','queued','running',
    'waiting_external','succeeded','failed','cancelled'
  )),
  schema_version INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  state_snapshot_json TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('mutation','sensitive','destructive')),
  expires_at TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_session_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, plan_hash)
);
CREATE INDEX ai_plans_conversation_created_idx
  ON ai_plans(conversation_id, created_at DESC);

CREATE TABLE ai_plan_runs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES ai_plans(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN (
    'queued','running','waiting_external','succeeded','failed','cancelled'
  )),
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_plan_runs_plan_created_idx ON ai_plan_runs(plan_id, created_at DESC);

CREATE TABLE ai_plan_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_plan_runs(id) ON DELETE CASCADE,
  plan_step_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','skipped')),
  idempotency_key TEXT NOT NULL UNIQUE,
  result_json TEXT,
  error_code TEXT,
  error_summary TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE ai_secret_refs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_secret_refs_expiry_idx ON ai_secret_refs(expires_at);

CREATE TABLE ai_provider_configs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('openai-compatible')),
  name TEXT NOT NULL,
  base_url TEXT,
  api_key_ciphertext TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  allow_private_network INTEGER NOT NULL DEFAULT 0 CHECK(allow_private_network IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_model_profiles (
  id TEXT PRIMARY KEY,
  provider_config_id TEXT NOT NULL REFERENCES ai_provider_configs(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  answer_capable INTEGER NOT NULL DEFAULT 0 CHECK(answer_capable IN (0,1)),
  action_planner_capable INTEGER NOT NULL DEFAULT 0 CHECK(action_planner_capable IN (0,1)),
  last_probe_at TEXT,
  probe_version INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(provider_config_id, model_id)
);

CREATE TABLE ai_resource_locks (
  resource_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_plan_runs(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
