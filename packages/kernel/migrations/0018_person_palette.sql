-- 0018_person_palette (P28-04): which palette the app is drawn in for a person. Forward-only: never edit this file once applied.
--
-- `people.palette` is the theme the person picked in Settings → Appearance: `classic` (the look the app had before themes, the default), `graphite`, `linen` or
-- `harbor`. It sits beside `people.theme` (light, dark or follow the device, 0017): the two together say what is drawn. A new column with its own CHECK, so the
-- theme CHECK of 0017 is not touched. Served in the session (`GET /api/session`) and changed by `PUT /api/me/appearance`; the existing people_update policy
-- already lets a person change their own row, so there is no new table and no new policy.

ALTER TABLE app.people
  ADD COLUMN palette text NOT NULL DEFAULT 'classic' CHECK (palette IN ('classic', 'graphite', 'linen', 'harbor'));
