ALTER TABLE signal_occurrences ADD COLUMN IF NOT EXISTS first_seen timestamptz;
