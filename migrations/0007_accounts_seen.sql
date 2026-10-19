-- Who has signed in (the library load records it), so tools can find an account's id from its email.
CREATE TABLE accounts (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX accounts_email ON accounts (email);
