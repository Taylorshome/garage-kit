-- Researched data per car (recalls, TSBs, schedule, known issues, diagnosis, recommendations, questions)
CREATE TABLE research (
  car_id TEXT PRIMARY KEY REFERENCES cars(id) ON DELETE CASCADE,
  data TEXT NOT NULL,      -- the research JSON as supplied (shapes differ per car; the UI normalises)
  md TEXT,                 -- the full written report (markdown)
  updated_at INTEGER NOT NULL
);
ALTER TABLE schedule_items ADD COLUMN source TEXT;              -- manual | typical | user | seed
ALTER TABLE schedule_items ADD COLUMN severe INTEGER NOT NULL DEFAULT 0;  -- 1 = severe-service variant
ALTER TABLE schedule_items ADD COLUMN severe_note TEXT;         -- severe-service guidance text
ALTER TABLE todos ADD COLUMN source TEXT;                       -- seed | scan | research:<key> | user
UPDATE schedule_items SET source = 'seed';
UPDATE todos SET source = 'seed' WHERE source IS NULL;
