PRAGMA foreign_keys = ON;

ALTER TABLE ai_conversations
  ADD COLUMN model_profile_id TEXT REFERENCES ai_model_profiles(id) ON DELETE SET NULL;

CREATE INDEX ai_conversations_model_profile_idx
  ON ai_conversations(model_profile_id);
