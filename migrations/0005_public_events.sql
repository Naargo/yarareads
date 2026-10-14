-- Reads on the public site (no PIN), kept apart from Yara's own events so her practice stats stay hers.
-- Anonymous: no device id, no words tapped. Just which story, which page, and when.
CREATE TABLE public_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type TEXT NOT NULL,
  story_id TEXT,
  page INTEGER
);
