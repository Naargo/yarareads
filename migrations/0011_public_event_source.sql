-- Where an anonymous visitor came from, when the link said (?from=pinterest on our pins). Kept on the device from
-- the first visit and sent with each public event, so we can count readers per channel, not just clicks.
ALTER TABLE public_events ADD COLUMN source TEXT;
