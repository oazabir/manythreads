-- 0017_person_appearance (P21-21): how the app looks for a person. Forward-only: never edit this file once applied.
--
-- `people.theme` is the colour choice (`system` follows the device, `light`, `dark`) and `people.density` is how close messages sit (`comfortable` or `compact`).
-- Both are served in the session (`GET /api/session`) so a new browser or device draws the same way as the last one. A person changes only their own row (the
-- existing people_update policy covers it; an admin may too, as for every other column). No new table and no new policy.

ALTER TABLE app.people
  ADD COLUMN theme   text NOT NULL DEFAULT 'system'      CHECK (theme IN ('system', 'light', 'dark')),
  ADD COLUMN density text NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact'));
