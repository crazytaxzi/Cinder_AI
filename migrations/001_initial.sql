
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  server_id TEXT,
  channel_id TEXT,
  actor JSONB NOT NULL,
  text TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_server_channel_time_idx
  ON events (server_id, channel_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_actor_time_idx
  ON events ((actor->>'platformUserId'), occurred_at DESC);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  preferred_name TEXT,
  pronunciation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS identities (
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  username TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS identities_person_idx ON identities(person_id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id) ON DELETE CASCADE,
  server_id TEXT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 50 CHECK (importance BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS memories_person_idx ON memories(person_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_server_idx ON memories(server_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS guild_settings (
  server_id TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  requested_by_platform_user_id TEXT NOT NULL,
  requested_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  description TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_arguments JSONB NOT NULL,
  origin_channel_id TEXT NOT NULL,
  approval_channel_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by_platform_user_id TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS pending_approvals_lookup_idx
  ON pending_approvals(server_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  server_id TEXT,
  actor_platform_user_id TEXT,
  tool_name TEXT NOT NULL,
  tool_arguments JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS actions_event_idx ON actions(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS actions_server_idx ON actions(server_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_external_events (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, external_id)
);

CREATE TABLE IF NOT EXISTS bridge_commands (
  id TEXT PRIMARY KEY,
  bridge_id TEXT NOT NULL,
  command JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bridge_commands_queue_idx ON bridge_commands(bridge_id, status, created_at);

