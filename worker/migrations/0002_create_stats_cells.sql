-- Precomputed relative-coloring baselines, one row per
-- (garage, local day_of_week, local hour) cell. Rebuilt by the daily
-- maintenance cron (rebuildStats in src/index.js) from a trailing window of
-- samples, so the /stats endpoint is a cheap indexed read instead of a 90-day
-- scan + percentile pass on every request.
--
-- day_of_week (0=Sun..6=Sat) and hour (0..23) are LOCAL America/Chicago, matching
-- how the client looks up "now". computed_at is the epoch of the rebuild that
-- wrote the row: the same rebuild deletes any cell left with an older
-- computed_at, so cells whose samples have aged out of the window disappear.
-- Percentiles are of available_spaces. Resolution is deliberately concentrated
-- at the LOW (scarce / "full") tail, which is what someone checking parking
-- cares about: p01 is event-level packing, up through p75. Above p75 there is
-- plenty of room and no finer gradation is stored (the empty end isn't useful).
CREATE TABLE IF NOT EXISTS stats_cells (
  garage_id    TEXT    NOT NULL,
  day_of_week  INTEGER NOT NULL,
  hour         INTEGER NOT NULL,
  observations INTEGER NOT NULL,
  p01          INTEGER NOT NULL,
  p10          INTEGER NOT NULL,
  p25          INTEGER NOT NULL,
  p50          INTEGER NOT NULL,
  p75          INTEGER NOT NULL,
  computed_at  INTEGER NOT NULL,  -- unix epoch seconds, UTC
  PRIMARY KEY (garage_id, day_of_week, hour)
) STRICT, WITHOUT ROWID;
