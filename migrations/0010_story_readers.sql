-- A book from home is owned by one account (stories.owner) and can be shared with others in the family:
-- each row lets one more account see (and read) the book. push.mjs --share writes these.
CREATE TABLE story_readers (
  story_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  PRIMARY KEY (story_id, sub)
);
