PRAGMA foreign_keys = ON;

CREATE TABLE ai_reauth_grants (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX ai_reauth_grants_expiry_idx ON ai_reauth_grants(expires_at);
