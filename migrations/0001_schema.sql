-- Garage schema

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sub TEXT UNIQUE,                  -- OIDC subject; bound on first sign-in when NULL
  name TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0, -- owners can edit the members list
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE senders (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE cars (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  year INTEGER,
  make TEXT,
  model TEXT,
  trim TEXT,
  engine TEXT,
  transmission TEXT,
  vin TEXT,
  body_type TEXT NOT NULL DEFAULT 'sedan',   -- minivan | sedan | pickup
  color TEXT NOT NULL DEFAULT '#8a8f98',
  mileage INTEGER,
  mileage_updated_at TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE schedule_items (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  interval_miles INTEGER,
  interval_months INTEGER,
  last_done_date TEXT,            -- YYYY-MM-DD
  last_done_miles INTEGER,
  due_now INTEGER NOT NULL DEFAULT 0, -- owner says it's due now regardless of interval
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX schedule_items_car ON schedule_items(car_id);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  mileage INTEGER,
  title TEXT NOT NULL,
  details TEXT,
  parts TEXT,
  cost_cents INTEGER,
  shop TEXT,                       -- shop name, or NULL when DIY
  diy INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX services_car ON services(car_id, date);

CREATE TABLE service_items (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, item_id)
);

CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',  -- high | medium | low
  status TEXT NOT NULL DEFAULT 'open',      -- open | closed
  dtc_code TEXT,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX todos_car ON todos(car_id, status);

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  car_id TEXT REFERENCES cars(id) ON DELETE SET NULL,  -- NULL = Unmatched inbox
  received_at INTEGER NOT NULL,
  from_addr TEXT,
  subject TEXT,
  vin TEXT,
  vehicle TEXT,
  mileage INTEGER,
  scan_date TEXT,
  summary TEXT,
  readiness TEXT,
  freeze_frame TEXT,
  match_how TEXT,
  note TEXT,
  raw_key TEXT,
  text_key TEXT
);
CREATE INDEX scans_car ON scans(car_id, received_at);

CREATE TABLE scan_codes (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  description TEXT,
  module TEXT,
  status TEXT
);
CREATE INDEX scan_codes_scan ON scan_codes(scan_id);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  car_id TEXT REFERENCES cars(id) ON DELETE CASCADE,
  service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
  scan_id TEXT REFERENCES scans(id) ON DELETE CASCADE,
  store TEXT NOT NULL,            -- r2 | kv
  key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,             -- user | assistant
  content TEXT NOT NULL,
  author TEXT,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX chat_messages_chat ON chat_messages(chat_id, id);
