-- Reliability (Nov 24, 2026): AI answer failures are logged, cut-off answers are flagged instead of saved as if complete,
-- stuck first-checks notes can be detected, and failed research jobs are announced exactly once.
ALTER TABLE chat_messages ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;   -- 1 = answer was cut off; UI offers "continue"
ALTER TABLE todos ADD COLUMN ai_updated_at INTEGER;   -- when the first-checks note was last requested/written (stale "pending" detection)
ALTER TABLE todos ADD COLUMN ai_error TEXT;           -- why the last first-checks attempt failed (the previous good note is kept)
ALTER TABLE research_jobs ADD COLUMN failure_notified_at INTEGER;   -- set once the household has been told about a failed job
UPDATE research_jobs SET failure_notified_at = COALESCE(finished_at, created_at) WHERE status = 'failed';
-- Anything other than a clean first-attempt answer: recovered (retry/continue/fallback worked), truncated, failed
CREATE TABLE ai_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- chat | chat_continue | first_checks
  ref TEXT,                  -- chat id or to-do id
  outcome TEXT NOT NULL,     -- recovered | truncated | failed
  model TEXT,                -- model of the final attempt
  trace TEXT                 -- JSON [{model, mode, result, chars, finish, ms, error?}]
);
CREATE INDEX ai_failures_at ON ai_failures(at);
