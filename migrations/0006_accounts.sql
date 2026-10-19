-- Accounts: everything that was Yara's alone now belongs to an account, keyed on the finereli-login Google id (sub).
-- What existed before accounts is held by the legacy account 'family' (the PIN), until someone claims it from the
-- App tab (POST /api/claim moves it to their account).
CREATE TABLE account_inventory (
  sub TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO account_inventory (sub, body, updated_at) SELECT 'family', body, updated_at FROM inventory;

CREATE TABLE account_settings (
  sub TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sub, key)
);
INSERT INTO account_settings (sub, key, value, updated_at) SELECT 'family', key, value, updated_at FROM settings;

ALTER TABLE events ADD COLUMN sub TEXT;
UPDATE events SET sub = 'family';
CREATE INDEX events_sub ON events (sub, type);

-- owner NULL: part of the shared library (our own series). Otherwise a private book, visible only to that account.
ALTER TABLE stories ADD COLUMN owner TEXT;
UPDATE stories SET owner = 'family' WHERE json_extract(body, '$.kind') = 'book';
