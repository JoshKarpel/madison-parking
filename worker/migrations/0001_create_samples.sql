-- One row per garage per distinct upstream sample.
--
-- observed_at is the feed's own "modified" timestamp normalized to UTC epoch
-- SECONDS (see parseFeedModified in src/index.js). It pairs with garage_id as the
-- primary key so that polling the feed faster than it refreshes is idempotent:
-- INSERT OR IGNORE drops a sample whose (garage_id, observed_at) we already have.
--
-- No capacity column: the feed never reports capacity, and capacity is static
-- rather than time-series, so it does not belong here. If the city ever exposes
-- it, add a separate garage -> capacity table and join.
CREATE TABLE IF NOT EXISTS samples (
  garage_id        TEXT    NOT NULL,
  observed_at      INTEGER NOT NULL,  -- unix epoch seconds, UTC
  available_spaces INTEGER NOT NULL,
  PRIMARY KEY (garage_id, observed_at)
) STRICT, WITHOUT ROWID;

-- Serves /history/sync (observed_at > ?) across all garages.
CREATE INDEX IF NOT EXISTS idx_samples_observed_at ON samples(observed_at);
