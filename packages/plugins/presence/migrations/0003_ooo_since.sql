-- presence 0003: when an out-of-office period began and ended (P18-05, docs/plans/catch-me-up.md). Forward-only: never edit once applied.
--
-- "Since I was away", a range of the Summary panel, starts when the person switched out of office on. The note itself only said whether it is on now, so the
-- two moments are kept beside it: `ooo_since` (switched on) and `ooo_ended_at` (switched off). A trigger sets both from the change of `ooo_active`; nobody writes
-- them by hand (a value a person sends in an update is replaced; only the system role may set them), so a person cannot move the start of their own absence to read further back than the 30 days the
-- summary allows anyway. Readable like the rest of the row (members of the workspace), which already says whether someone is out of office.

ALTER TABLE app.person_status
  ADD COLUMN ooo_since    timestamptz,
  ADD COLUMN ooo_ended_at timestamptz;

-- The best guess for a note switched on before this migration: its row's last change.
UPDATE app.person_status SET ooo_since = updated_at WHERE ooo_active;

CREATE FUNCTION app.person_status_ooo_times() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.ooo_since := CASE WHEN NEW.ooo_active THEN now() END;
    NEW.ooo_ended_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.ooo_active AND NOT OLD.ooo_active THEN
    NEW.ooo_since := now();
    NEW.ooo_ended_at := NULL;
  ELSIF OLD.ooo_active AND NOT NEW.ooo_active THEN
    NEW.ooo_since := OLD.ooo_since;
    NEW.ooo_ended_at := now();
  ELSIF NOT app.is_system() THEN
    -- the platform (a data repair, a test) may set the two moments; a person's own update keeps them
    NEW.ooo_since := OLD.ooo_since;
    NEW.ooo_ended_at := OLD.ooo_ended_at;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER person_status_ooo_times BEFORE INSERT OR UPDATE ON app.person_status FOR EACH ROW EXECUTE FUNCTION app.person_status_ooo_times();
