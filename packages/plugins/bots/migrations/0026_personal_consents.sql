-- bots 0026 (P20-09): which bots may read a person's Personal space, and the one database fact that says what a live run may read. Forward-only.
--
--  * app.bots.scope: 'team' (every bot so far: it lives in one team's repo) or 'workspace' (the one Brain of the workspace, added by a later migration of this
--    plugin). Only the system role writes the column, and the loader only ever writes 'team' until the workspace Brain lands, so no team lead can make a bot
--    that counts as the Brain. The default answer to "may this bot read my Personal space" is yes for the workspace Brain alone.
--  * app.bot_personal_consents: a person's own answer per bot. Only the person reads or writes their rows (an admin cannot see who said what); the system role
--    (and so the definer function below, which runs as it) reads them, and deletes them when a person or a bot goes away (the cascades do it). No row means "the default": yes for the workspace Brain, no for every other bot.
--  * app.run_space_context(): the spaces the CALLING transaction's live run may read, derived from the run's own row and never from anything a bot sends.
--    Every read tool (messages, files, knowledge, memory) asks it, so the rule has one home. It answers:
--      audience        'personal' when the run answers a person inside their own private context (a conversation with a bot, a DM, a bot conversation),
--                      'team' for everything else (a team channel, a routine, a webhook): such a run reads its own team only;
--      asker_person_id the person who asked, when the asker is an active non-guest member (only they have a Personal space);
--      personal_allowed true when audience is 'personal', the asker has a Personal space, the bot is the workspace Brain or lists `personal.read` in its
--                      BOT.md, and the person's answer (or the default) is yes. Checked again on every call, so a withdrawn yes ends the next call;
--      personal_reason null when allowed, else one of: team_audience, no_asker, no_personal_space, not_requested, declined.
--    It answers only while the run is live and only when app.actor() is the run's bot or the person who asked (the pair the run service sets), like
--    app.memory_run_scope(). It is SECURITY DEFINER because the bot may not read the other tables it joins; inside, app.is_system() is TRUE, so the caller is
--    checked with app.actor() and never with is_system().

ALTER TABLE app.bots ADD COLUMN scope text NOT NULL DEFAULT 'team' CHECK (scope IN ('team', 'workspace'));
ALTER TABLE app.bots ADD CONSTRAINT bots_scope_visibility CHECK (scope = 'team' OR visibility = 'workspace');
COMMENT ON COLUMN app.bots.scope IS 'team: defined in one team''s repo. workspace: the one Brain of the workspace. Written only by the system role.';

-- bot_personal_consents (P; person own) ---------------------------------------------------------------------------------
CREATE TABLE app.bot_personal_consents (
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  bot_id       uuid NOT NULL REFERENCES app.bots (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  allowed      boolean NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, bot_id)
);
CREATE INDEX bot_personal_consents_bot ON app.bot_personal_consents (bot_id);
CREATE INDEX bot_personal_consents_workspace ON app.bot_personal_consents (workspace_id);
COMMENT ON TABLE app.bot_personal_consents IS 'rls: person — own: only the person reads or writes their answers (an admin cannot); the system role may delete (retention).';

ALTER TABLE app.bot_personal_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bot_personal_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY bot_personal_consents_select ON app.bot_personal_consents FOR SELECT USING (person_id = (SELECT app.person_id()) OR (SELECT app.is_system()));
CREATE POLICY bot_personal_consents_insert ON app.bot_personal_consents FOR INSERT
  WITH CHECK (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()));
CREATE POLICY bot_personal_consents_update ON app.bot_personal_consents FOR UPDATE
  USING (person_id = (SELECT app.person_id())) WITH CHECK (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id()));
CREATE POLICY bot_personal_consents_delete ON app.bot_personal_consents FOR DELETE USING (person_id = (SELECT app.person_id()) OR (SELECT app.is_system()));
GRANT SELECT, INSERT, UPDATE, DELETE ON app.bot_personal_consents TO manythreads_app;

-- run_space_context -----------------------------------------------------------------------------------------------------
CREATE FUNCTION app.run_space_context()
  RETURNS TABLE (run_id uuid, workspace_id uuid, team_id uuid, bot_id uuid, trigger_type text, audience text,
                 asker_person_id uuid, personal_allowed boolean, personal_reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_run          app.bot_runs%ROWTYPE;
  v_bot_actor    uuid;
  v_bot          app.bots%ROWTYPE;
  v_audience     text;
  v_person       uuid;
  v_member_role  text;
  v_allowed      boolean := false;
  v_reason       text;
  v_answer       boolean;
BEGIN
  SELECT r.* INTO v_run FROM app.bot_runs r WHERE r.id = app.run_id() AND r.status = 'running' AND r.ended_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT a.id INTO v_bot_actor FROM app.actors a WHERE a.kind = 'bot' AND a.ref_id = v_run.bot_id AND a.workspace_id = v_run.workspace_id;
  IF v_bot_actor IS NULL THEN RETURN; END IF;
  -- only the run's bot or the person who asked may ask
  IF NOT (app.actor() = v_bot_actor OR (v_run.asker_id IS NOT NULL AND app.actor() = v_run.asker_id)) THEN RETURN; END IF;
  SELECT b.* INTO v_bot FROM app.bots b WHERE b.id = v_run.bot_id;

  -- the audience: a private context of the person (a conversation, a DM, a conversation with a bot) or a team context
  v_audience := CASE
    WHEN v_run.trigger_type = 'conversation' THEN 'personal'
    WHEN v_run.channel_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.channels c WHERE c.id = v_run.channel_id AND c.kind IN ('dm', 'bot_conversation')) THEN 'personal'
    WHEN v_run.channel_id IS NULL AND v_run.thread_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM app.threads th JOIN app.channels c ON c.id = th.channel_id
       WHERE th.root_message_id = v_run.thread_id AND c.kind IN ('dm', 'bot_conversation')) THEN 'personal'
    ELSE 'team'
  END;

  IF v_audience <> 'personal' THEN
    v_reason := 'team_audience';
  ELSIF v_run.asker_id IS NULL THEN
    v_reason := 'no_asker';
  ELSE
    SELECT p.id, wm.role INTO v_person, v_member_role
      FROM app.actors a
      JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id AND p.status = 'active'
      JOIN app.workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.person_id = p.id
     WHERE a.id = v_run.asker_id AND a.kind = 'person' AND a.workspace_id = v_run.workspace_id;
    IF v_person IS NULL OR v_member_role = 'guest' THEN
      v_person := NULL;
      v_reason := 'no_personal_space';
    ELSIF v_bot.scope = 'workspace' AND v_bot.slug = 'brain' THEN
      -- the workspace Brain: yes unless the person said no
      SELECT c.allowed INTO v_answer FROM app.bot_personal_consents c WHERE c.person_id = v_person AND c.bot_id = v_bot.id;
      v_allowed := coalesce(v_answer, true);
      IF NOT v_allowed THEN v_reason := 'declined'; END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM app.capability_grants g WHERE g.actor_id = v_bot_actor AND g.capability = 'personal.read') THEN
      v_reason := 'not_requested';
    ELSE
      -- any other bot: the definition asks AND the person said yes; no answer is a no
      SELECT c.allowed INTO v_answer FROM app.bot_personal_consents c WHERE c.person_id = v_person AND c.bot_id = v_bot.id;
      v_allowed := coalesce(v_answer, false);
      IF NOT v_allowed THEN v_reason := 'declined'; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_run.id, v_run.workspace_id, v_run.team_id, v_run.bot_id, v_run.trigger_type, v_audience, v_person, v_allowed, v_reason;
END
$$;

GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.run_space_context() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.run_space_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.run_space_context() TO manythreads_app, manythreads_system;
COMMENT ON FUNCTION app.run_space_context() IS
  'What the calling transaction''s live run (app.run_id()) may read: its audience (personal or team), the asker''s person id, and whether the asker''s Personal space is open to this bot right now, with the reason when it is not. No row for any other transaction.';

-- bot_consent_rows: the Account page's list ------------------------------------------------------------------------------
-- One row per active bot the caller can see, with the answer in force. A person cannot read other teams' capability grants, so `can_ask` (the definition lists
-- personal.read) is computed here. A guest has no Personal space and sees nothing.
CREATE FUNCTION app.bot_consent_rows()
  RETURNS TABLE (bot_id uuid, bot_slug text, bot_name text, can_ask boolean, allowed boolean, is_default boolean, changed_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_role   text := app.lookup_workspace_role();
  v_person uuid := app.person_id();
  v_teams  uuid[] := app.readable_team_ids('read');
BEGIN
  IF v_role IS NULL OR v_role = 'guest' OR v_person IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT b.id, b.slug, b.name,
         (b.scope = 'workspace' AND b.slug = 'brain')
           OR EXISTS (SELECT 1 FROM app.actors a JOIN app.capability_grants g ON g.actor_id = a.id AND g.capability = 'personal.read'
                       WHERE a.kind = 'bot' AND a.ref_id = b.id AND a.workspace_id = b.workspace_id),
         coalesce(c.allowed, b.scope = 'workspace' AND b.slug = 'brain'),
         c.allowed IS NULL,
         c.changed_at
    FROM app.bots b
    LEFT JOIN app.bot_personal_consents c ON c.bot_id = b.id AND c.person_id = v_person
   WHERE b.workspace_id = app.workspace_id() AND b.status = 'active'
     AND (b.team_id = ANY (v_teams) OR b.visibility = 'workspace')
   ORDER BY b.name, b.slug;
END
$$;
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.bot_consent_rows() OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
REVOKE ALL ON FUNCTION app.bot_consent_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bot_consent_rows() TO manythreads_app;
