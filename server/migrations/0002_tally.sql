-- Tally data snapshots: business data (companies, ledgers, vouchers) read from Tally's own XML
-- server at backup time, so backups can be viewed and compared in Tally terms.
-- The snapshot itself is gzip JSON in R2 at tally/<sha256>.json.gz.
CREATE TABLE tally_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_key   TEXT    NOT NULL,           -- Tally company number (data folder name) or, if unknown, the name
  company_name  TEXT    NOT NULL,
  folder        TEXT,                       -- backed-up company folder (relative path), when known
  captured_at   INTEGER NOT NULL,
  hash          TEXT    NOT NULL,           -- sha256 of the uncompressed JSON
  raw_size      INTEGER NOT NULL,
  stored_size   INTEGER NOT NULL,
  ledgers       INTEGER NOT NULL DEFAULT 0,
  vouchers      INTEGER NOT NULL DEFAULT 0,
  last_voucher  TEXT,                       -- newest voucher date (YYYY-MM-DD)
  device        TEXT,
  user_id       INTEGER
);
CREATE INDEX idx_tally_company ON tally_snapshots(company_key, captured_at);
CREATE INDEX idx_tally_hash ON tally_snapshots(hash);
