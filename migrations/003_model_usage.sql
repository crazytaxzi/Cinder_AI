CREATE TABLE IF NOT EXISTS model_usage (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id TEXT NOT NULL,
  request_id TEXT,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  input_usd_per_million NUMERIC(12,6) NOT NULL,
  cached_input_usd_per_million NUMERIC(12,6) NOT NULL,
  output_usd_per_million NUMERIC(12,6) NOT NULL,
  estimated_cost_usd NUMERIC(16,8) NOT NULL
);
CREATE INDEX IF NOT EXISTS model_usage_time_idx ON model_usage (occurred_at DESC);
CREATE INDEX IF NOT EXISTS model_usage_turn_idx ON model_usage (turn_id);
