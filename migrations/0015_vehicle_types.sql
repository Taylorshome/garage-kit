-- Vehicle types: cars, trucks, vans, SUVs, motorcycles, side-by-sides (UTV) and ATVs, plus engine hours.
-- vehicle_type drives the logic (starter schedules, fluids warnings, parts sources, wording, hours);
-- body_type still picks the 3D / SVG model (it gains cruiser, sport, dualsport, scooter, utv, atv).
ALTER TABLE cars ADD COLUMN vehicle_type TEXT NOT NULL DEFAULT 'car';   -- car | truck | van | suv | motorcycle | utv | atv
-- Engine hours (off-road vehicles are serviced by hours; most UTVs also show miles, so both are kept).
ALTER TABLE cars ADD COLUMN hours REAL;
ALTER TABLE cars ADD COLUMN hours_updated_at TEXT;
-- Per-vehicle facts that change the maintenance logic, JSON:
-- {"cooling":"air|liquid|oil-air","fuel_system":"carbureted|efi","clutch":"wet|dry|cvt","final_drive":"chain|shaft|belt",
--  "shared_sump":true,"needs_info":["vin","mileage","hours","color","variant"]}
ALTER TABLE cars ADD COLUMN attrs TEXT;

-- existing rows: the type follows the body style they already have (sedan / coupe / hatchback stay "car")
UPDATE cars SET vehicle_type = CASE body_type WHEN 'minivan' THEN 'van' WHEN 'pickup' THEN 'truck' WHEN 'suv' THEN 'suv' ELSE 'car' END;

-- Due by miles, hours or date, whichever comes first (months only = a date-based item such as tire age).
ALTER TABLE schedule_items ADD COLUMN interval_hours REAL;
ALTER TABLE schedule_items ADD COLUMN last_done_hours REAL;
ALTER TABLE services ADD COLUMN hours REAL;          -- engine hours at the service (receipt drafts carry it in their JSON)

-- Engine-hour readings over time (like mileage_log), for hours per month and the history of readings.
CREATE TABLE hours_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  date TEXT NOT NULL,            -- YYYY-MM-DD (the garage's time zone)
  hours REAL NOT NULL,
  source TEXT,                   -- web | mcp | service | ha | catchup | receipt
  created_at INTEGER NOT NULL
);
CREATE INDEX hours_log_car ON hours_log(car_id, date);
