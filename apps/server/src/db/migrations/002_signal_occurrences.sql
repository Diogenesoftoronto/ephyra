CREATE TABLE IF NOT EXISTS signal_occurrences (
  id bigserial PRIMARY KEY,
  fingerprint text NOT NULL,
  observed_at timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0)
);
CREATE INDEX IF NOT EXISTS signal_occurrences_lookup ON signal_occurrences (fingerprint, observed_at);
