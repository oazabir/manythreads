-- 0014_slug_immutable (P5-12 review): a workspace's and a team's slug never change. Forward-only: never edit this file once applied.
--
-- docs/plugins/teams.md has always said "rename (the slug never changes)", but only the API enforced it. Things now derive names from the two slugs
-- that must stay put: the team memory bank is `team:<workspace slug>:<team slug>` (memory-hindsight), and a changed slug would leave the team's whole
-- memory in a bank nobody reads, or hand it to whichever team takes the old name. The guard is a trigger so it holds for every writer: the API,
-- plugins, the system role and manual SQL. An UPDATE that sets the slug to the value it already has (an upsert) is fine.

CREATE FUNCTION app.slug_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'the slug of a % cannot be changed (names such as memory banks are derived from it)', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER workspaces_slug_immutable BEFORE UPDATE OF slug ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.slug_immutable();
CREATE TRIGGER teams_slug_immutable BEFORE UPDATE OF slug ON app.teams FOR EACH ROW EXECUTE FUNCTION app.slug_immutable();
