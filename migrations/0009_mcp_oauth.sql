-- MCP over OAuth 2.1, the way the spec asks (after the Accountant): dynamic client registration, authorization code with
-- PKCE, rotating refresh tokens. A parent approves an agent by signing in with Google through login.finereli.com; the tokens
-- then belong to that account (sub). Tokens are stored hashed. Replaces the 'agent' kind of agent_tokens, which is now
-- only used for one-hour preview links.
CREATE TABLE mcp_clients (
  id TEXT PRIMARY KEY,
  name TEXT,
  redirect_uris TEXT NOT NULL,     -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE mcp_pending (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE mcp_tokens (
  hash TEXT PRIMARY KEY,           -- sha256 of the token, base64url
  kind TEXT NOT NULL,              -- code | access | refresh
  client_id TEXT NOT NULL,
  sub TEXT NOT NULL,               -- the account that approved
  redirect_uri TEXT,
  code_challenge TEXT,
  expires_at INTEGER NOT NULL,     -- epoch seconds
  last_used TEXT
);
CREATE INDEX mcp_tokens_sub ON mcp_tokens (sub, kind);
DELETE FROM agent_tokens WHERE kind = 'agent';
