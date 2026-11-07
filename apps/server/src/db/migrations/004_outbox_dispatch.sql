ALTER TABLE outbox ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
CREATE INDEX IF NOT EXISTS outbox_trail_pending ON outbox (trail_id) WHERE dispatched_at IS NULL;
