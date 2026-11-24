-- Symptoms (a to-do of type "symptom") + attachments on to-dos + AI first-checks note
ALTER TABLE todos ADD COLUMN type TEXT;             -- NULL = plain to-do, 'symptom'
ALTER TABLE todos ADD COLUMN symptom TEXT;          -- JSON {kind:[], when:[], where:[]}
ALTER TABLE todos ADD COLUMN reporter TEXT;         -- member name (+ "via <client>" for MCP)
ALTER TABLE todos ADD COLUMN mileage INTEGER;       -- odometer when reported
ALTER TABLE todos ADD COLUMN text_hash TEXT;        -- dedupe: same car + same normalised text
ALTER TABLE todos ADD COLUMN ai_note TEXT;          -- mechanic's "first things to check, cheapest first"
ALTER TABLE todos ADD COLUMN ai_status TEXT;        -- pending | done | error
ALTER TABLE todos ADD COLUMN ai_model TEXT;
CREATE INDEX todos_hash ON todos(car_id, text_hash);
ALTER TABLE files ADD COLUMN todo_id TEXT REFERENCES todos(id) ON DELETE CASCADE;
