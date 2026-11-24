-- "Not professional advice" acknowledgement, once per person (member + the name typed at sign-in for the shared
-- household login). In no-sign-in mode the browser also remembers it (localStorage); this row is the server-side flag.
CREATE TABLE disclaimer_acks (
  ack_key TEXT PRIMARY KEY,
  member_id TEXT,
  name TEXT,
  version INTEGER NOT NULL,
  at INTEGER NOT NULL
);
