-- Parts / guides / TopScan / pressure tester / additives research per car, plus the curated fluids table
CREATE TABLE parts_guides (
  car_id TEXT PRIMARY KEY REFERENCES cars(id) ON DELETE CASCADE,
  data TEXT NOT NULL,     -- research/*-parts-guides.json as supplied (shapes vary; the UI normalises)
  md TEXT,                -- the written report
  fluids TEXT NOT NULL,   -- tools/fluids.json entry for the car
  updated_at INTEGER NOT NULL
);
