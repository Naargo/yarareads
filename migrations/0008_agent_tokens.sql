-- Keys for agents. 'agent' tokens let someone's own agent (Claude, ChatGPT...) manage that account's books through
-- /mcp. 'preview' tokens last an hour and let the app be opened read-only as the account, so an agent can look at its work.
-- Only a hash of each token is kept.
CREATE TABLE agent_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  sub TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);
CREATE INDEX agent_tokens_sub ON agent_tokens (sub, kind);
