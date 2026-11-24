-- Receipt capture (Nov 24, 2026): a photo / PDF / email / Claude upload becomes a pending receipt (an AI-read draft).
-- Confirming it logs a service (same path as + Log), marks schedule items done and moves the files onto the service.
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | saving | saved | discarded
  parse_status TEXT NOT NULL DEFAULT 'parsing', -- parsing | done | failed | fields (Claude sent structured fields; no AI read needed)
  source TEXT NOT NULL,                     -- app | email | mcp
  car_id TEXT REFERENCES cars(id) ON DELETE SET NULL,
  draft TEXT,                               -- JSON draft (see src/receipts.js normalizeDraft)
  text_key TEXT,                            -- KV: text read from the receipt (PDF/email/transcription)
  content_hash TEXT,                        -- dedupe: same files / same text / same fields
  model TEXT,
  error TEXT,
  from_addr TEXT,
  subject TEXT,
  created_by TEXT,                          -- member name (+ "via <client>" from Claude, "by email")
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  saved_at INTEGER,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  notify INTEGER NOT NULL DEFAULT 0,        -- 1 = announce through the notification integration (email receipts)
  notified_at INTEGER
);
CREATE INDEX receipts_status ON receipts(status, created_at);
CREATE INDEX receipts_hash ON receipts(content_hash);
ALTER TABLE files ADD COLUMN receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL;
