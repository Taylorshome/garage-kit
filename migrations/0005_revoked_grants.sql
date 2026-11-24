-- Immediate revocation for MCP grants: the OAuth provider keeps tokens in KV (eventually consistent, ~60 s),
-- so revoking from Settings also records the grant's nonce here and /mcp checks it on every request.
CREATE TABLE revoked_grants (
  nonce TEXT PRIMARY KEY,
  member_id TEXT,
  revoked_at INTEGER NOT NULL
);
