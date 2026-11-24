-- Brand comparisons per part (one row per part: the van file alone is ~310 KB, over D1's 100 KB statement cap)
CREATE TABLE brands (
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  part TEXT NOT NULL,
  category TEXT,
  matched_part TEXT,      -- name of the matching parts_guides part, NULL = brand-only (added to the Parts tab)
  data TEXT NOT NULL,     -- {part, category, options[], pick, avoid[], note?}
  PRIMARY KEY (car_id, idx)
);
CREATE TABLE brands_meta (
  car_id TEXT PRIMARY KEY REFERENCES cars(id) ON DELETE CASCADE,
  meta TEXT NOT NULL,     -- {vehicle, as_of, notes[], extra_parts_added[], oil_filter_tick?}
  md TEXT,
  updated_at INTEGER NOT NULL
);
