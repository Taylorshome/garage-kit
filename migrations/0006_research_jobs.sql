-- Deep research per symptom / to-do, done by the optional research worker (headless Claude Code with WebSearch/WebFetch only) or by hand from Claude
CREATE TABLE research_jobs (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  result TEXT,                              -- validated report JSON
  error TEXT,
  meta TEXT,                                -- worker info (duration, cost, model) - no secrets
  seen_at INTEGER                           -- first time a member opened it (for the "New research" badge)
);
CREATE INDEX research_jobs_status ON research_jobs(status, created_at);
CREATE INDEX research_jobs_todo ON research_jobs(todo_id, created_at);
ALTER TABLE todos ADD COLUMN reporter_id TEXT;      -- member id of whoever reported it
ALTER TABLE todos ADD COLUMN researched_at INTEGER; -- last successful deep research
