CREATE TABLE IF NOT EXISTS turn_failures (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  server_id TEXT,
  channel_id TEXT,
  actor_platform_user_id TEXT,
  error_name TEXT NOT NULL,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  request_id TEXT,
  error_code TEXT,
  http_status INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS turn_failures_created_idx ON turn_failures(created_at DESC);
CREATE INDEX IF NOT EXISTS turn_failures_server_idx ON turn_failures(server_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  remote_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dashboard_audit_created_idx ON dashboard_audit(created_at DESC);
