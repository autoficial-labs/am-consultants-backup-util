-- AM Backup schema. All timestamps are Unix epoch milliseconds (UTC).

-- Accounts --------------------------------------------------------------------
CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT    NOT NULL,
  password_hash  TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('superadmin', 'user')),
  access         TEXT    NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'write')),
  scope_mode     TEXT    NOT NULL DEFAULT 'none' CHECK (scope_mode IN ('all', 'include', 'exclude', 'none')),
  disabled       INTEGER NOT NULL DEFAULT 0,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

-- Folders listed for a user's 'include' / 'exclude' scope (relative to the backup root).
CREATE TABLE user_paths (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path     TEXT    NOT NULL,
  PRIMARY KEY (user_id, path)
);

CREATE TABLE sessions (
  token_hash    TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device        TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Backup policy and other shared settings (JSON values).
CREATE TABLE settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- File storage ----------------------------------------------------------------
-- Content-addressed file data stored in R2 at blobs/<aa>/<sha256>, zstd-compressed.
CREATE TABLE blobs (
  hash         TEXT    PRIMARY KEY,
  size         INTEGER NOT NULL,
  stored_size  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_blobs_created ON blobs(created_at);

-- One row per sync run (a set of changes uploaded together).
CREATE TABLE batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER,
  device          TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  added           INTEGER NOT NULL DEFAULT 0,
  modified        INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded  INTEGER NOT NULL DEFAULT 0,
  message         TEXT
);
CREATE INDEX idx_batches_started ON batches(started_at);

-- Every change ever recorded. Point-in-time restore picks the newest row per path
-- with created_at <= the chosen moment.
CREATE TABLE versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL,
  op          TEXT    NOT NULL CHECK (op IN ('add', 'modify', 'delete')),
  hash        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  batch_id    INTEGER,
  user_id     INTEGER
);
CREATE INDEX idx_versions_path_time ON versions(path, created_at);
CREATE INDEX idx_versions_time ON versions(created_at);
CREATE INDEX idx_versions_hash ON versions(hash);

-- Latest known state per path (tombstones kept with deleted = 1).
CREATE TABLE files (
  path        TEXT    PRIMARY KEY,
  hash        TEXT,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  version_id  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Complete, highly compressed archives of the whole folder (tar + zstd) in R2 at full/<id>.tar.zst.
CREATE TABLE full_backups (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key           TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'complete', 'failed')),
  origin           TEXT    NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'scheduled')),
  file_count       INTEGER NOT NULL DEFAULT 0,
  original_size    INTEGER NOT NULL DEFAULT 0,
  compressed_size  INTEGER NOT NULL DEFAULT 0,
  compression      TEXT    NOT NULL DEFAULT 'zstd',
  level            INTEGER,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  user_id          INTEGER,
  device           TEXT,
  note             TEXT
);
CREATE INDEX idx_full_created ON full_backups(created_at);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  user_id   INTEGER,
  username  TEXT,
  action    TEXT    NOT NULL,
  detail    TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
