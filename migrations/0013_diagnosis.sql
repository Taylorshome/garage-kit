-- Guided diagnosis: plans (ordered checks per car + symptom), sessions walking a plan one step at a time,
-- and the results per step. Research plans are loaded by scripts/load-research.mjs (research/<car>/diagnosis-plans.json); AI ones by src/diagnosis.js.
CREATE TABLE diag_plans (
  id TEXT PRIMARY KEY,                     -- e.g. sedan-brake-squeal, or ai-<car>-<symptom>-<rand>
  car_id TEXT REFERENCES cars(id) ON DELETE CASCADE,   -- the car it was built for (also matches same year/make/model)
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,                    -- research | ai
  symptom TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,                      -- JSON plan (see docs/research-schema.md)
  status TEXT NOT NULL DEFAULT 'active',   -- active | retired
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE diag_sessions (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  plan TEXT NOT NULL,                      -- snapshot of the plan the session started with
  symptom TEXT NOT NULL,
  todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,   -- the symptom to-do it belongs to, if any
  status TEXT NOT NULL DEFAULT 'active',   -- active | found | inconclusive | abandoned
  conclusion TEXT,
  confidence TEXT,                         -- high | medium | low | user
  found_cause TEXT,
  summary TEXT,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,   -- the history entry written at the end
  fix_todo_id TEXT REFERENCES todos(id) ON DELETE SET NULL,
  started_by TEXT,
  started_by_id TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX diag_sessions_car ON diag_sessions(car_id, status, updated_at);
CREATE TABLE diag_results (
  session_id TEXT NOT NULL REFERENCES diag_sessions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  result TEXT NOT NULL,                    -- option key | skipped
  notes TEXT,
  mileage INTEGER,
  recorded_by TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, step_id)
);
ALTER TABLE files ADD COLUMN diag_session_id TEXT REFERENCES diag_sessions(id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN diag_step TEXT;

-- Hand-added shopping list items (tools, supplies) shown next to the computed brand picks.
CREATE TABLE shopping_extras (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'part',       -- part | tool | supply
  brand TEXT,
  part_number TEXT,
  price_usd TEXT,
  where_buy TEXT,
  url TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',     -- open | bought | removed
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX shopping_extras_car ON shopping_extras(car_id, status);
