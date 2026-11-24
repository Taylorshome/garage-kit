-- Catch-up screen: approximate last-done values from "about when did you last do this?" answers.
-- last_done_estimated = 1: last_done_date (and last_done_miles, when the car's miles/month is known) are estimates,
-- shown with "~" in the UI. A real logged service or "Set last done" clears it.
ALTER TABLE schedule_items ADD COLUMN last_done_estimated INTEGER NOT NULL DEFAULT 0;
-- catch-up answer: this_month | 3mo | 6mo | 1yr | 2yr | unknown ("Don't remember") | never; NULL = not reviewed yet
ALTER TABLE schedule_items ADD COLUMN catchup_answer TEXT;
ALTER TABLE schedule_items ADD COLUMN catchup_at INTEGER;

-- Odometer readings over time (mileage updates, services, the monthly Home Assistant check).
-- Used to work out a car's typical miles per month.
CREATE TABLE mileage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  date TEXT NOT NULL,            -- YYYY-MM-DD (the garage time zone)
  miles INTEGER NOT NULL,
  source TEXT,                   -- web | mcp | service | ha | catchup
  created_at INTEGER NOT NULL
);
CREATE INDEX mileage_log_car ON mileage_log(car_id, date);
