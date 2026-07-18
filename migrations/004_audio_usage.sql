CREATE TABLE IF NOT EXISTS audio_usage (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model TEXT NOT NULL,
  platform TEXT NOT NULL,
  duration_seconds NUMERIC(12,3) NOT NULL,
  estimated_cost_usd NUMERIC(16,8) NOT NULL
);
CREATE INDEX IF NOT EXISTS audio_usage_time_idx ON audio_usage (occurred_at DESC);
