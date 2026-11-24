-- Kit additions: per-car uploaded 3D model (.glb in KV), web push subscriptions + the notification feed the
-- service worker reads, and once-only notification bookkeeping (daily due reminders, monthly mileage check).
ALTER TABLE cars ADD COLUMN model_key TEXT;          -- KV key of an uploaded .glb (NULL = procedural body style)
ALTER TABLE cars ADD COLUMN model_size INTEGER;
ALTER TABLE cars ADD COLUMN model_updated_at INTEGER;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT,
  auth TEXT,
  member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  label TEXT,                    -- browser / device, from the user agent
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
);

-- What a notification says. Pushes carry no payload (no encryption needed); the service worker fetches the newest
-- rows here (signed-in cookie) and shows them.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- due | mileage | research | research_failed | receipt | test
  title TEXT NOT NULL,
  body TEXT,
  url TEXT                       -- in-app hash link, e.g. #/car/<id>/todo
);
CREATE INDEX notifications_at ON notifications(at);

-- key -> last time it was announced (e.g. "due:<item id>:overdue", "mileage:2026-12")
CREATE TABLE notify_state (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
