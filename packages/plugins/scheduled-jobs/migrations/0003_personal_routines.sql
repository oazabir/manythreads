-- scheduled-jobs plugin 0003 (P20-10, P20-14; D10): a person's own routines. Forward-only: never edit once applied.
--
-- A personal routine is a scheduled job that belongs to ONE person: `owner_person_id` is set and `team_id` is NULL (exactly one of the two, the space
-- shape of kernel 0016). It runs as a bot, with the owner as the ASKER of every run (`asker_person_id`, a generated copy of the owner: nobody sets it, so
-- nothing can make it differ), so what it reads is what its owner may read in a private context and what it writes goes only into the owner's own space.
--
--  * scheduled_jobs: team_id and bot_id may now be NULL; owner_person_id, the generated asker, the routine's folder `slug`, the person's sentence (`words`), the
--    schedule in words, the time zone, the sources it reads, the output mode, why the platform switched it off (`stopped_reason` / `stopped_at`) and the recipe it
--    came from. A CHECK keeps each row either a team job (as before) or a whole personal routine. Policies follow the space template: the owner (and an admin
--    during a live audited open, read only) reads a personal row; only the owner changes or deletes it; the system role files the firings.
--  * a guard trigger: a person changes what a routine SAYS and turns it on or off; the owner, the bot and the stop reason are the platform's (a person clears a
--    stop by turning the routine on again). At most 20 routines per person, taken in turns by an advisory lock.
--  * a bot's removal switches its personal routines off with the reason `bot_gone` (bot_id becomes NULL instead of the routine being deleted with the bot), so
--    the owner is told and nothing disappears quietly.
--  * scheduled_job_runs: team_id may be NULL, owner_person_id and `sources_used` (what the run read, one line each, never text).
--  * routine_person_settings (time zone and quiet hours, the person's own) and routine_workspace_settings (the monthly spending allowance per person, $5 until an
--    admin changes it).
--  * scheduled_jobs_fire is made again for both kinds; routine_spend_month reads what a person's routines spent, through the model gateway's ledger.

-- scheduled_jobs ---------------------------------------------------------------------------------------------------------------
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER TABLE app.scheduled_jobs ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE app.scheduled_jobs ALTER COLUMN bot_id DROP NOT NULL;
ALTER TABLE app.scheduled_jobs
  ADD COLUMN owner_person_id uuid REFERENCES app.people (id) ON DELETE CASCADE,
  ADD COLUMN asker_person_id uuid GENERATED ALWAYS AS (owner_person_id) STORED,
  ADD COLUMN slug            text CHECK (slug IS NULL OR slug ~ '^[a-z][a-z0-9-]{0,39}$'),
  ADD COLUMN words           text NOT NULL DEFAULT '' CHECK (char_length(words) <= 2000),
  ADD COLUMN schedule_words  text CHECK (schedule_words IS NULL OR char_length(schedule_words) BETWEEN 1 AND 120),
  ADD COLUMN time_zone       text CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 64),
  ADD COLUMN sources         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(sources) <= 20),
  ADD COLUMN output_mode     text CHECK (output_mode IS NULL OR output_mode IN ('create', 'replace', 'append')),
  ADD COLUMN stopped_reason  text CHECK (stopped_reason IS NULL OR stopped_reason IN
    ('bot_off', 'bot_gone', 'consent_withdrawn', 'connection_gone', 'owner_deactivated', 'spend_cap', 'not_a_member')),
  ADD COLUMN stopped_at      timestamptz,
  ADD COLUMN stop_told_at    timestamptz,
  ADD COLUMN recipe_id       text CHECK (recipe_id IS NULL OR recipe_id ~ '^[a-z][a-z0-9-]{0,39}$');

ALTER TABLE app.scheduled_jobs ADD CONSTRAINT scheduled_jobs_one_owner CHECK (num_nonnulls(team_id, owner_person_id) = 1);
ALTER TABLE app.scheduled_jobs ADD CONSTRAINT scheduled_jobs_bot_or_stopped CHECK (bot_id IS NOT NULL OR (owner_person_id IS NOT NULL AND NOT enabled));
ALTER TABLE app.scheduled_jobs ADD CONSTRAINT scheduled_jobs_personal_shape CHECK (
  owner_person_id IS NULL
  OR (kind = 'routine' AND slug IS NOT NULL AND schedule_words IS NOT NULL AND time_zone IS NOT NULL AND output_mode IS NOT NULL
      AND contract_path IS NOT NULL AND output_path IS NOT NULL)
);
ALTER TABLE app.scheduled_jobs ADD CONSTRAINT scheduled_jobs_stop_shape CHECK (
  (stopped_reason IS NULL) = (stopped_at IS NULL) AND (stopped_reason IS NULL OR NOT enabled)
);
CREATE UNIQUE INDEX scheduled_jobs_owner_slug ON app.scheduled_jobs (owner_person_id, slug) WHERE owner_person_id IS NOT NULL;
CREATE INDEX scheduled_jobs_owner ON app.scheduled_jobs (owner_person_id) WHERE owner_person_id IS NOT NULL;
-- the watch over stopped routines: the ones whose owner has not been told yet
CREATE INDEX scheduled_jobs_stop_untold ON app.scheduled_jobs (stopped_at) WHERE stopped_reason IS NOT NULL AND stop_told_at IS NULL;
COMMENT ON TABLE app.scheduled_jobs IS 'rls: team — T for a team job (readable_team_ids), P for a personal routine (owner_person_id): its owner reads and changes it, an admin reads it only during a live audited open of the space; the system role files firings and stops routines.';

DROP POLICY scheduled_jobs_select ON app.scheduled_jobs;
DROP POLICY scheduled_jobs_insert ON app.scheduled_jobs;
DROP POLICY scheduled_jobs_update ON app.scheduled_jobs;
DROP POLICY scheduled_jobs_delete ON app.scheduled_jobs;
CREATE POLICY scheduled_jobs_select ON app.scheduled_jobs FOR SELECT USING (
  (SELECT app.is_system())
  OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[])
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);
CREATE POLICY scheduled_jobs_insert ON app.scheduled_jobs FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[]) AND created_by = (SELECT app.actor()))
  OR (owner_person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()) AND created_by = (SELECT app.actor()))
);
CREATE POLICY scheduled_jobs_update ON app.scheduled_jobs FOR UPDATE USING (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
  OR owner_person_id = (SELECT app.person_id())
) WITH CHECK (
  (SELECT app.is_system())
  OR team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
  OR owner_person_id = (SELECT app.person_id())
);
-- A personal routine is deleted by its owner; a team job is still removed only by the system role.
CREATE POLICY scheduled_jobs_delete ON app.scheduled_jobs FOR DELETE USING (
  (SELECT app.is_system()) OR owner_person_id = (SELECT app.person_id())
);

-- What a person may change of a personal routine. Everything about who owns it and which bot runs it is the platform's.
CREATE FUNCTION app.scheduled_jobs_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.owner_person_id IS NOT NULL THEN
      -- one at a time per person, so two requests cannot both take the 20th place
      PERFORM pg_advisory_xact_lock(hashtextextended('scheduled_jobs_personal:' || NEW.owner_person_id::text, 0));
      IF (SELECT count(*) FROM app.scheduled_jobs j WHERE j.owner_person_id = NEW.owner_person_id) >= 20 THEN
        RAISE EXCEPTION 'You already have 20 routines; remove one to make room for another.' USING ERRCODE = 'check_violation';
      END IF;
      IF NOT app.is_system() AND NEW.stopped_reason IS NOT NULL THEN
        RAISE EXCEPTION 'Only the platform stops a routine.' USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- a guest has no Personal space, so no routines
      IF NOT app.is_system() AND coalesce(app.lookup_workspace_role(), 'guest') = 'guest' THEN
        RAISE EXCEPTION 'A guest has no routines.' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.bot_id IS DISTINCT FROM OLD.bot_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    IF OLD.owner_person_id IS NOT NULL THEN
      RAISE EXCEPTION 'Who owns a routine, which bot runs it and its folder are not changed.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD.owner_person_id IS NOT NULL THEN
    -- a stop is set by the platform; a person only clears it (by turning the routine on)
    IF NEW.stopped_reason IS NOT NULL AND NEW.stopped_reason IS DISTINCT FROM OLD.stopped_reason THEN
      RAISE EXCEPTION 'Only the platform stops a routine.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.stop_told_at IS DISTINCT FROM OLD.stop_told_at AND NEW.stopped_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Only the platform records that a stop was told.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.enabled AND OLD.bot_id IS NULL THEN
      RAISE EXCEPTION 'A routine whose bot is gone cannot be turned on.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.scheduled_jobs_guard() FROM PUBLIC;
CREATE TRIGGER scheduled_jobs_guard BEFORE INSERT OR UPDATE ON app.scheduled_jobs FOR EACH ROW EXECUTE FUNCTION app.scheduled_jobs_guard();

-- A bot that is removed does not take its owners' routines with it: they are switched off with a reason, and the owner is told. Runs as the system role
-- (a definer function), because the person who removes the bot's definition may not read, let alone change, another person's routine.
CREATE FUNCTION app.scheduled_jobs_bot_gone() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE app.scheduled_jobs
     SET bot_id = NULL, enabled = false, next_run_at = NULL, stopped_reason = 'bot_gone', stopped_at = now(), stop_told_at = NULL, updated_at = now()
   WHERE bot_id = OLD.id AND owner_person_id IS NOT NULL;
  RETURN OLD;
END
$$;
CREATE TRIGGER scheduled_jobs_bot_gone BEFORE DELETE ON app.bots FOR EACH ROW EXECUTE FUNCTION app.scheduled_jobs_bot_gone();

-- scheduled_job_runs -----------------------------------------------------------------------------------------------------------
ALTER TABLE app.scheduled_job_runs ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE app.scheduled_job_runs
  ADD COLUMN owner_person_id uuid REFERENCES app.people (id) ON DELETE CASCADE,
  ADD COLUMN sources_used jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources_used) = 'array' AND jsonb_array_length(sources_used) <= 50);
ALTER TABLE app.scheduled_job_runs ADD CONSTRAINT scheduled_job_runs_one_owner CHECK (num_nonnulls(team_id, owner_person_id) = 1);
CREATE INDEX scheduled_job_runs_owner ON app.scheduled_job_runs (owner_person_id, started_at DESC) WHERE owner_person_id IS NOT NULL;
COMMENT ON TABLE app.scheduled_job_runs IS 'rls: team — T for a team job, P for a personal routine (owner_person_id): its owner reads the firings, an admin only during a live audited open; written by the system role only.';

DROP POLICY scheduled_job_runs_select ON app.scheduled_job_runs;
CREATE POLICY scheduled_job_runs_select ON app.scheduled_job_runs FOR SELECT USING (
  (SELECT app.is_system())
  OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[])
  OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
);

-- The person's time zone and quiet hours; the workspace's spending allowance ---------------------------------------------------
CREATE TABLE app.routine_person_settings (
  person_id    uuid PRIMARY KEY REFERENCES app.people (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  time_zone    text CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 64),
  quiet_from   text CHECK (quiet_from IS NULL OR quiet_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_to     text CHECK (quiet_to IS NULL OR quiet_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routine_person_settings_quiet_pair CHECK ((quiet_from IS NULL) = (quiet_to IS NULL)),
  CONSTRAINT routine_person_settings_quiet_differs CHECK (quiet_from IS NULL OR quiet_from <> quiet_to)
);
CREATE INDEX routine_person_settings_workspace ON app.routine_person_settings (workspace_id);
COMMENT ON TABLE app.routine_person_settings IS 'rls: person — P (own only): a person''s time zone and quiet hours for their routines; nobody else reads or changes them, an admin included; the system role reads them to hold a firing back.';
ALTER TABLE app.routine_person_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.routine_person_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY routine_person_settings_select ON app.routine_person_settings FOR SELECT USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY routine_person_settings_insert ON app.routine_person_settings FOR INSERT
  WITH CHECK (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()));
CREATE POLICY routine_person_settings_update ON app.routine_person_settings FOR UPDATE
  USING (person_id = (SELECT app.person_id())) WITH CHECK (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()));
CREATE POLICY routine_person_settings_delete ON app.routine_person_settings FOR DELETE USING (person_id = (SELECT app.person_id()) OR (SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.routine_person_settings TO manythreads_app;

CREATE TABLE app.routine_workspace_settings (
  workspace_id    uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  monthly_cap_usd numeric(10, 2) NOT NULL DEFAULT 5 CHECK (monthly_cap_usd >= 0 AND monthly_cap_usd <= 10000),
  updated_by      uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routine_workspace_settings_updated_by ON app.routine_workspace_settings (updated_by) WHERE updated_by IS NOT NULL;
COMMENT ON TABLE app.routine_workspace_settings IS 'rls: workspace — W: every member of the workspace reads the monthly spending allowance per person; only workspace owners and admins change it (a workspace with no row has the default of 5 US dollars).';
ALTER TABLE app.routine_workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.routine_workspace_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY routine_workspace_settings_select ON app.routine_workspace_settings FOR SELECT
  USING ((SELECT app.is_system()) OR workspace_id = (SELECT app.workspace_id()));
CREATE POLICY routine_workspace_settings_insert ON app.routine_workspace_settings FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY routine_workspace_settings_update ON app.routine_workspace_settings FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT, INSERT, UPDATE ON app.routine_workspace_settings TO manythreads_app;

-- The firing door, made again for both kinds -----------------------------------------------------------------------------------
DROP FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text);

CREATE FUNCTION app.scheduled_jobs_fire(p_scheduled_job_id uuid, p_at timestamptz, p_output_path text, p_failure text)
  RETURNS SETOF app.scheduled_job_runs
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_job app.scheduled_jobs;
  v_status text := CASE WHEN p_failure IS NULL THEN 'queued' ELSE 'failed' END;
  v_task uuid;
  v_row app.scheduled_job_runs;
  v_me uuid;
BEGIN
  SELECT * INTO v_job FROM app.scheduled_jobs WHERE id = p_scheduled_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such scheduled job' USING ERRCODE = 'P0002';
  END IF;
  -- `app.is_system()` reads the transaction's actor kind (it is not fooled by this function's owner), which is what the tick job sets.
  IF NOT app.is_system() THEN
    IF v_job.owner_person_id IS NOT NULL THEN
      SELECT a.ref_id INTO v_me FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = v_job.workspace_id;
      IF v_me IS DISTINCT FROM v_job.owner_person_id THEN
        RAISE EXCEPTION 'only the owner of a routine, or the system, can fire it' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT app.lookup_can('team', v_job.team_id, 'manage') THEN
      RAISE EXCEPTION 'only a lead of this team, or the system, can fire a scheduled job' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_job.kind = 'task' AND p_failure IS NULL AND v_job.team_id IS NOT NULL THEN
    INSERT INTO app.tasks (workspace_id, team_id, title, description, kind, priority, branch, created_by)
    VALUES (v_job.workspace_id, v_job.team_id, v_job.name,
            format('Created by the “%s” job.', v_job.name), 'other', 'normal',
            'scheduled-job/' || v_job.id::text, v_job.created_by)
    RETURNING id INTO v_task;
    INSERT INTO app.task_events (task_id, team_id, actor_id, type, data)
    VALUES (v_task, v_job.team_id, NULL, 'created', jsonb_build_object('scheduledJobId', v_job.id));
  END IF;

  INSERT INTO app.scheduled_job_runs (scheduled_job_id, team_id, owner_person_id, task_id, status, output_path, reason, started_at, ended_at)
  VALUES (p_scheduled_job_id, v_job.team_id, v_job.owner_person_id, v_task, v_status,
          coalesce(p_output_path, v_job.output_path), left(coalesce(p_failure, ''), 500),
          p_at, CASE WHEN v_status = 'failed' THEN p_at ELSE NULL END)
  RETURNING * INTO v_row;

  RETURN NEXT v_row;
END
$$;

ALTER FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scheduled_jobs_fire(uuid, timestamptz, text, text) TO manythreads_app;

-- What a person's routines spent this month: the model gateway's ledger lines of the runs their routines opened. Only the person themself asks.
CREATE FUNCTION app.routine_spend_month(p_person uuid, p_from timestamptz) RETURNS numeric
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_me uuid;
BEGIN
  SELECT a.ref_id INTO v_me FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'person';
  IF v_me IS NULL OR v_me IS DISTINCT FROM p_person THEN
    RAISE EXCEPTION 'a person reads only their own spending' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT sum(s.cost_usd)
      FROM app.scheduled_job_runs r
      JOIN app.llm_spend s ON s.run_id = r.run_id
     WHERE r.owner_person_id = p_person AND r.started_at >= p_from
  ), 0);
END
$$;
ALTER FUNCTION app.routine_spend_month(uuid, timestamptz) OWNER TO manythreads_system;
REVOKE ALL ON FUNCTION app.routine_spend_month(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.routine_spend_month(uuid, timestamptz) TO manythreads_app;

ALTER FUNCTION app.scheduled_jobs_bot_gone() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
