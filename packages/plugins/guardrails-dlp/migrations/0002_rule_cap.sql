-- guardrails-dlp 0002: the cap on custom rules, enforced by the database (PLAN P10-04). Forward-only: never edit once applied.
--
-- The route counts before it inserts, but a route is not the only door: a second request at the same moment, or any other code with insert rights, would
-- get past a count that only the route makes. Every rule is read on every outgoing piece of text, so the number is a bound on work as well as on tidiness.
-- 20 is the same number as DLP_CUSTOM_RULES_MAX in the shared package. A per-workspace advisory lock makes two inserts at once take turns.

CREATE FUNCTION app.dlp_custom_rules_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('dlp_custom_rules:' || NEW.workspace_id::text, 0));
  IF (SELECT count(*) FROM app.dlp_custom_rules WHERE workspace_id = NEW.workspace_id) >= 20 THEN
    RAISE EXCEPTION 'A workspace can have at most 20 data-loss rules.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.dlp_custom_rules_cap() FROM PUBLIC;
CREATE TRIGGER dlp_custom_rules_cap BEFORE INSERT ON app.dlp_custom_rules FOR EACH ROW EXECUTE FUNCTION app.dlp_custom_rules_cap();
