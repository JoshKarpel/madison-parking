-- Precomputed slot baselines for the "unusual for this day and hour?" tidbit and
-- the chart's "typical" overlay, one row per (garage, local day_of_week, local
-- hour) cell. Rebuilt weekly by the maintenance cron (rebuildStats in
-- src/index.js) from ALL retained history, so the /stats endpoint is a cheap
-- indexed read instead of a full scan + percentile pass on every request. (These
-- are NOT the fullness color; that comes from the stats_garage capacity estimate.)
--
-- day_of_week (0=Sun..6=Sat) and hour (0..23) are LOCAL America/Chicago, matching
-- how the client looks up "now". computed_at is the epoch of the rebuild that
-- wrote the row: the same rebuild deletes any cell left with an older
-- computed_at, so cells whose samples have aged out of retention disappear.
-- Percentiles are of available_spaces. Resolution is deliberately concentrated
-- at the LOW (scarce) tail, which is what the tidbit cares about (busier than
-- usual): p01 is event-level packing, up through p75. Above p75 no finer
-- gradation is stored.
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
