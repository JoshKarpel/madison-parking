-- Per-garage ESTIMATED total capacity, refreshed by the weekly maintenance cron
-- (rebuildStats in src/index.js). The feed never reports capacity, so we estimate
-- it as a high-water mark of availability: the 99th percentile of available_spaces
-- over a trailing window. A downtown ramp empties out overnight, so its emptiest
-- observed state approximates its total. The 99th percentile rather than the raw
-- max shrugs off a stray high reading; a trailing window rather than all history
-- lets the estimate track a real capacity change (e.g. a floor closing) instead of
-- locking in a value that no longer holds.
--
-- It is an ESTIMATE, surfaced as such in the UI, never presented as exact. Stored
-- apart from stats_cells because capacity is per-garage, not per (day, hour).
-- computed_at is the rebuild epoch that wrote the row; the same rebuild deletes
-- rows left with an older computed_at, so a garage that stops reporting drops out.
CREATE TABLE IF NOT EXISTS stats_garage (
  garage_id   TEXT    NOT NULL,
  capacity    INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,  -- unix epoch seconds, UTC
  PRIMARY KEY (garage_id)
) STRICT, WITHOUT ROWID;
