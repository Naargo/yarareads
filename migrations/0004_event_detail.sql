-- Free-text detail for an event, e.g. how a word's audio went: "played 640ms cached ctx=running iPad".
ALTER TABLE events ADD COLUMN detail TEXT;
