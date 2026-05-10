-- Add an optional free-text "source" label so workflows can be branded
-- (e.g. for organisation-distributed workflows). NULL = fall back to the
-- default display ("Myself" for owner / "Mike" for built-ins).
ALTER TABLE workflows ADD COLUMN source_label TEXT;
