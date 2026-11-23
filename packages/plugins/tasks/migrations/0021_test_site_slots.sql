-- tasks plugin 0021: the test-site slots a card leases (P35-03, docs/plans/test-site-per-card.md). Forward-only: never edit once applied.
--
-- A team's deploy targets (the chart's `hermesPods.deployTargets`) are its slots: one namespace and one host each, where one card's test site runs at a
-- time. The server writes the list from its settings (`tasks_sync_test_site_slots`, system only); a card's owner (the Deployer) leases a slot for the
-- card (`tasks_lease_test_site`), and only one build runs at a time across a team's slots (a 40-minute build lock: two builds at once do not fit the
-- node). The server frees a slot when the card is done, its pull request is closed, or the site idles (`tasks_release_test_site` and
-- `tasks_test_site_freed`, system only, after it deleted the site).

CREATE TABLE app.test_site_slots (
  namespace      text PRIMARY KEY CHECK (namespace ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  workspace_id   uuid NOT NULL,
  team_id        uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  host           text NOT NULL CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  state          text NOT NULL DEFAULT 'free' CHECK (state IN ('free', 'leased', 'releasing')),
  task_id        uuid REFERENCES app.tasks (id) ON DELETE SET NULL,
  leased_at      timestamptz,
  last_deploy_at timestamptz,
  building_until timestamptz,
  release_reason text NOT NULL DEFAULT '' CHECK (length(release_reason) <= 200),
  -- false once the setting no longer lists it: never leased again, freed as usual
  listed         boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX test_site_slots_one_per_card ON app.test_site_slots (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX test_site_slots_team ON app.test_site_slots (team_id);

ALTER TABLE app.test_site_slots ENABLE ROW LEVEL SECURITY;
-- a team's readers see its slots (who holds them); every change goes through the doors below
CREATE POLICY test_site_slots_read ON app.test_site_slots FOR SELECT TO manythreads_app
  USING (team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
-- the doors are owned by the system role, which writes the rows
CREATE POLICY test_site_slots_system ON app.test_site_slots FOR ALL TO manythreads_system USING (true) WITH CHECK (true);
GRANT SELECT ON app.test_site_slots TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.test_site_slots TO manythreads_system;

ALTER TABLE app.task_events DROP CONSTRAINT task_events_type_check;
ALTER TABLE app.task_events ADD CONSTRAINT task_events_type_check
  CHECK (type IN ('created', 'claimed', 'released', 'state_changed', 'handed_off', 'completed', 'reworked', 'deployed', 'not_woken',
                  'pull_request_opened', 'pull_request_closed', 'described', 'pull_request_reviewed', 'test_site', 'test_site_leased', 'test_site_removed'));

-- The slots from the server's settings: `p_slots` is a JSON list of {team (slug), namespace, host}. A listed slot is added or its host updated; a slot no
-- longer listed is kept (it may hold a site to remove) but never leased again.
CREATE FUNCTION app.tasks_sync_test_site_slots(p_slots jsonb)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_n integer := 0;
  v_e jsonb;
  v_team record;
BEGIN
  UPDATE app.test_site_slots SET listed = false;
  FOR v_e IN SELECT * FROM jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) LOOP
    SELECT t.id, t.workspace_id INTO v_team FROM app.teams t WHERE t.slug = v_e->>'team' LIMIT 1;
    CONTINUE WHEN NOT FOUND OR coalesce(v_e->>'host', '') = '' OR coalesce(v_e->>'namespace', '') = '';
    INSERT INTO app.test_site_slots (namespace, workspace_id, team_id, host)
    VALUES (v_e->>'namespace', v_team.workspace_id, v_team.id, lower(v_e->>'host'))
    ON CONFLICT (namespace) DO UPDATE SET host = EXCLUDED.host, team_id = EXCLUDED.team_id, workspace_id = EXCLUDED.workspace_id, listed = true;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$$;

-- Lease a slot for the card (its owner or a lead): the card's own slot when it has one, else a free listed slot of its team. `p_build` also takes the
-- team's build lock for 40 minutes (refused while another card's build holds it). Outcomes: leased (o_namespace, o_host), busy (every slot held:
-- o_holders names the cards), build_busy (o_holders names the card that builds), no_slots, not_found, not_owner, already_done.
CREATE FUNCTION app.tasks_lease_test_site(p_task_id uuid, p_build boolean)
  RETURNS TABLE (o_outcome text, o_namespace text, o_host text, o_holders text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_slot  record;
  v_who   text;
BEGIN
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, ''::text; RETURN; END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor AND NOT coalesce((SELECT app.lookup_can('team', v_task.team_id, 'manage')), false) THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::text, NULL::text, ''::text; RETURN;
  END IF;
  IF v_task.state = 'done' THEN RETURN QUERY SELECT 'already_done'::text, NULL::text, NULL::text, ''::text; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.test_site_slots s WHERE s.team_id = v_task.team_id AND s.listed) THEN
    RETURN QUERY SELECT 'no_slots'::text, NULL::text, NULL::text, ''::text; RETURN;
  END IF;
  -- the team's slots in one order, locked, so two cards leasing at once cannot take the same slot or two build locks
  PERFORM 1 FROM app.test_site_slots s WHERE s.team_id = v_task.team_id ORDER BY s.namespace FOR UPDATE;
  SELECT s.* INTO v_slot FROM app.test_site_slots s WHERE s.task_id = p_task_id AND s.state = 'leased';
  IF NOT FOUND THEN
    SELECT s.* INTO v_slot FROM app.test_site_slots s WHERE s.team_id = v_task.team_id AND s.listed AND s.state = 'free' ORDER BY s.namespace LIMIT 1;
    IF NOT FOUND THEN
      SELECT string_agg(format('%s (%s)', t.title, s.namespace), '; ' ORDER BY s.namespace) INTO v_who
        FROM app.test_site_slots s LEFT JOIN app.tasks t ON t.id = s.task_id WHERE s.team_id = v_task.team_id AND s.listed;
      RETURN QUERY SELECT 'busy'::text, NULL::text, NULL::text, coalesce(v_who, ''); RETURN;
    END IF;
    UPDATE app.test_site_slots SET state = 'leased', task_id = p_task_id, leased_at = now(), last_deploy_at = NULL, building_until = NULL, release_reason = ''
     WHERE namespace = v_slot.namespace;
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (p_task_id, v_task.team_id, v_actor, 'test_site_leased', jsonb_build_object('namespace', v_slot.namespace, 'host', v_slot.host));
  END IF;
  IF p_build THEN
    SELECT string_agg(format('%s (%s)', t.title, s.namespace), '; ') INTO v_who
      FROM app.test_site_slots s JOIN app.tasks t ON t.id = s.task_id
     WHERE s.team_id = v_task.team_id AND s.building_until > now() AND s.task_id <> p_task_id;
    IF v_who IS NOT NULL THEN
      RETURN QUERY SELECT 'build_busy'::text, v_slot.namespace, v_slot.host, v_who; RETURN;
    END IF;
    UPDATE app.test_site_slots SET building_until = now() + interval '40 minutes' WHERE namespace = v_slot.namespace;
  END IF;
  RETURN QUERY SELECT 'leased'::text, v_slot.namespace, v_slot.host, ''::text;
END
$$;

-- The card's site is up at its slot's host: the address goes on the card, the build lock is let go, and the idle clock starts again. A team with
-- slots accepts only the leased slot's host for the card; a team with none keeps 0020's rule (any https address).
CREATE OR REPLACE FUNCTION app.tasks_set_test_site(p_task_id uuid, p_url text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor uuid := app.actor();
  v_task  record;
  v_url   text := NULLIF(btrim(coalesce(p_url, '')), '');
  v_host  text;
  v_slot  record;
BEGIN
  IF v_url IS NOT NULL AND (length(v_url) > 300 OR v_url !~ '^https://[^/@?#[:space:]\\%]+(/[^@#[:space:]\\]*)?$') THEN RETURN 'invalid_input'; END IF;
  SELECT t.* INTO v_task FROM app.tasks t WHERE t.id = p_task_id AND t.team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]) FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_task.owner_id IS DISTINCT FROM v_actor AND NOT coalesce((SELECT app.lookup_can('team', v_task.team_id, 'manage')), false) THEN RETURN 'not_owner'; END IF;
  IF v_task.state = 'done' THEN RETURN 'already_done'; END IF;
  IF v_url IS NOT NULL AND EXISTS (SELECT 1 FROM app.test_site_slots s WHERE s.team_id = v_task.team_id AND s.listed) THEN
    v_host := lower(substring(v_url FROM '^https://([^/:]+)'));
    SELECT s.* INTO v_slot FROM app.test_site_slots s WHERE s.task_id = p_task_id AND s.state = 'leased';
    IF NOT FOUND OR v_slot.host <> v_host THEN RETURN 'not_leased'; END IF;
    UPDATE app.test_site_slots SET last_deploy_at = now(), building_until = NULL WHERE namespace = v_slot.namespace;
  END IF;
  UPDATE app.tasks SET test_site_url = v_url, updated_at = now() WHERE id = p_task_id;
  INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
  VALUES (p_task_id, v_task.team_id, v_actor, 'test_site', jsonb_build_object('url', v_url));
  RETURN 'recorded';
END
$$;

-- System only: the slots whose site must go, now marked `releasing` with the reason, for the teardown worker. Reasons: the card is done; its pull
-- request was closed; no deploy for p_idle (from the lease when none); leased longer than p_max; the card is gone.
CREATE FUNCTION app.tasks_release_test_sites(p_idle interval, p_max interval)
  RETURNS TABLE (o_namespace text, o_task_id uuid, o_reason text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.test_site_slots s
     SET state = 'releasing', building_until = NULL,
         release_reason = CASE WHEN t.id IS NULL THEN 'the card is gone'
                               WHEN t.state = 'done' THEN 'the card is done'
                               WHEN t.pull_request_state = 'closed' THEN 'its pull request was closed'
                               WHEN coalesce(s.last_deploy_at, s.leased_at) < now() - p_idle THEN 'no deploy for a day'
                               ELSE 'held for three days' END
    FROM app.test_site_slots s2 LEFT JOIN app.tasks t ON t.id = s2.task_id
   WHERE s2.namespace = s.namespace AND s.state = 'leased'
     AND (t.id IS NULL OR t.state = 'done' OR t.pull_request_state = 'closed'
          OR coalesce(s.last_deploy_at, s.leased_at) < now() - p_idle OR s.leased_at < now() - p_max);
  -- every slot to tear down: the ones just marked, and any whose earlier teardown failed
  RETURN QUERY SELECT s.namespace, s.task_id, s.release_reason FROM app.test_site_slots s WHERE s.state = 'releasing' ORDER BY s.namespace;
END
$$;

-- System only: the site is deleted. The slot is free, the card's link cleared, and its history says why.
CREATE FUNCTION app.tasks_test_site_freed(p_namespace text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_slot record;
BEGIN
  SELECT s.* INTO v_slot FROM app.test_site_slots s WHERE s.namespace = p_namespace FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_slot.task_id IS NOT NULL THEN
    UPDATE app.tasks SET test_site_url = NULL WHERE id = v_slot.task_id AND test_site_url IS NOT NULL;
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    SELECT v_slot.task_id, t.team_id, NULL, 'test_site_removed', jsonb_build_object('namespace', p_namespace, 'reason', v_slot.release_reason)
      FROM app.tasks t WHERE t.id = v_slot.task_id;
  END IF;
  UPDATE app.test_site_slots SET state = 'free', task_id = NULL, leased_at = NULL, last_deploy_at = NULL, building_until = NULL WHERE namespace = p_namespace;
  RETURN 'freed';
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.tasks_sync_test_site_slots(jsonb) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_lease_test_site(uuid, boolean) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_release_test_sites(interval, interval) OWNER TO manythreads_system;
ALTER FUNCTION app.tasks_test_site_freed(text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;

REVOKE ALL ON FUNCTION app.tasks_sync_test_site_slots(jsonb), app.tasks_lease_test_site(uuid, boolean), app.tasks_release_test_sites(interval, interval), app.tasks_test_site_freed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tasks_lease_test_site(uuid, boolean) TO manythreads_app, manythreads_system;
GRANT EXECUTE ON FUNCTION app.tasks_sync_test_site_slots(jsonb), app.tasks_release_test_sites(interval, interval), app.tasks_test_site_freed(text) TO manythreads_system;
