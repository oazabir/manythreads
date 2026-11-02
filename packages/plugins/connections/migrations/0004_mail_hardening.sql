-- connections 0004: hardening of the mail writer after the review of P8-29/P8-30. Forward-only: never edit once applied.
--
--   * app.connection_mail_claims_of_run   the one place that answers "which mail thread is THIS run answering?", from rows the platform wrote (never from anything a caller passes):
--                                         the claim linked to the run, the claim in the job that started the run (so an inbox run knows its mail from its first call, with no
--                                         race against the link to its first post), the claim whose post the run answers in, and the claim of a person-approved send that is
--                                         running now. It answers only for the run the transaction itself acts for (app.run_id()).
--   * app.connection_mail_put_outbound    now (a) refuses a connection that is switched off or past its end, and (b) takes a mail to answer (`p_reply_to`) only when it is
--                                         the mail of a claim THIS run answers on THIS connection. Before, any inbound mail of the connection could be named, and the recipient is
--                                         that mail's sender: a caller holding the grant could mail the sender of any thread.
--
-- Inside a definer function app.is_system() is always true, so the run is read from app.run_id() and the workspace from app.workspace_id() (set by the platform when it opens the
-- transaction), the way 0002 reads the actor.

CREATE FUNCTION app.connection_mail_claims_of_run(p_run uuid, p_body text DEFAULT NULL)
  RETURNS TABLE (claim_id uuid, connection_id uuid, mail_id uuid, thread_key text, route integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_workspace uuid := app.workspace_id();
BEGIN
  -- a run asks only for itself: the answer is about the transaction's own run, whoever the caller says it is
  IF p_run IS NULL OR p_run IS DISTINCT FROM app.run_id() OR v_workspace IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH r AS (
    SELECT x.id, x.workspace_id, x.bot_id, x.trigger_type, x.channel_id, x.thread_id, x.reply_root_id, x.job_id
      FROM app.bot_runs x WHERE x.id = p_run AND x.workspace_id = v_workspace
  ),
  linked AS (
    -- (0) the claim the run is linked to, or the claim in the job that started it: the run's own, from the first call on
    SELECT c.id, c.connection_id, c.mail_id, c.thread_key, 0 AS route, c.created_at
      FROM app.connection_mail_claims c
     WHERE c.workspace_id = v_workspace AND c.run_id = p_run
    UNION
    SELECT c.id, c.connection_id, c.mail_id, c.thread_key, 0, c.created_at
      FROM r JOIN app.jobs j ON j.id = r.job_id
      JOIN app.connection_mail_claims c ON c.workspace_id = v_workspace AND c.bot_id = r.bot_id AND c.id::text = j.payload #>> '{inbox,claimId}'
     WHERE r.trigger_type = 'inbox'
  ),
  threaded AS (
    -- (1) the claim whose post (the root of a mail thread in the channel) this run answers in
    SELECT c.id, c.connection_id, c.mail_id, c.thread_key, 1 AS route, c.created_at
      FROM r JOIN app.connection_mail_claims c ON c.workspace_id = v_workspace AND c.root_message_id IN (r.thread_id, r.reply_root_id)
  ),
  approved AS (
    -- (2) a send a person approved, running now: the run the approvals job opened has no thread and no job of its own, so it is found through the approval it carries out (same bot,
    -- same place, exactly the text that was approved) and the run that asked. More than one claim is ambiguous and counts as none: this route fails closed.
    SELECT c.id, c.connection_id, c.mail_id, c.thread_key, 2 AS route, c.created_at
      FROM r
      JOIN app.approvals a ON a.workspace_id = r.workspace_id AND a.bot_id = r.bot_id AND a.tool = 'email.send' AND a.status = 'approved' AND a.outcome = 'running'
                          AND a.channel_id IS NOT DISTINCT FROM r.channel_id AND a.thread_root_id IS NOT DISTINCT FROM r.reply_root_id
                          AND a.resume #>> '{args,body}' = p_body
      JOIN app.bot_runs o ON o.id = a.run_id
      JOIN app.connection_mail_claims c ON c.workspace_id = v_workspace
                                       AND (c.run_id = o.id OR c.root_message_id IN (o.thread_id, o.reply_root_id)
                                            OR (o.trigger_type = 'inbox' AND c.bot_id = o.bot_id AND c.id::text = (SELECT j.payload #>> '{inbox,claimId}' FROM app.jobs j WHERE j.id = o.job_id)))
     WHERE p_body IS NOT NULL
  )
  SELECT u.id, u.connection_id, u.mail_id, u.thread_key, u.route
    FROM (SELECT * FROM linked UNION ALL SELECT * FROM threaded UNION ALL SELECT * FROM approved) u
   WHERE u.route < 2 OR (SELECT count(DISTINCT a2.id) FROM approved a2) = 1
   ORDER BY u.route, u.created_at DESC;
END
$$;
REVOKE ALL ON FUNCTION app.connection_mail_claims_of_run(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connection_mail_claims_of_run(uuid, text) TO manythreads_app;
COMMENT ON FUNCTION app.connection_mail_claims_of_run(uuid, text) IS 'The mail claims the transaction''s own run answers (app.run_id()): linked to the run, in the job that started it, in the thread it answers in, or of a person-approved send running now. Nothing for any other run.';

CREATE OR REPLACE FUNCTION app.connection_mail_put_outbound(
  p_connection uuid, p_tool text, p_reply_to uuid, p_to text, p_subject text, p_body text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  v_actor     uuid := app.actor();
  v_workspace uuid := app.workspace_id();
  v_conn      record;
  v_orig      record;
  v_to        text;
  v_thread    text;
  v_in_reply  text;
  v_ref       text := '<' || uuidv7()::text || '@mail.manythreads.invalid>';
  v_id        uuid;
BEGIN
  IF p_tool NOT IN ('email.send', 'email.draft') THEN
    RAISE EXCEPTION 'connection_mail_put_outbound writes email.send and email.draft only' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.id, c.team_id, c.workspace_id, c.slug, c.status, c.expires_at INTO v_conn
    FROM app.connection_grants g
    JOIN app.connections c ON c.id = g.connection_id AND c.team_id = g.team_id
   WHERE g.actor_id = v_actor AND g.connection_id = p_connection AND g.tool = p_tool AND c.scope = 'team' AND c.kind = 'email'
     AND g.workspace_id = v_workspace AND c.workspace_id = v_workspace;
  IF v_conn.id IS NULL THEN
    RAISE EXCEPTION 'no grant for % on this connection', p_tool USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- the code above checks this too (the source), but the database is the last door: a switched-off or expired connection writes nothing
  IF v_conn.status <> 'enabled' OR (v_conn.expires_at IS NOT NULL AND v_conn.expires_at <= now()) THEN
    RAISE EXCEPTION 'this connection is switched off or has expired' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_reply_to IS NOT NULL THEN
    SELECT m.from_address, m.thread_key, m.message_id INTO v_orig
      FROM app.connection_messages m
     WHERE m.id = p_reply_to AND m.connection_id = p_connection AND m.direction = 'in';
    IF v_orig.thread_key IS NULL THEN
      RAISE EXCEPTION 'the mail to answer is not in this mailbox' USING ERRCODE = 'no_data_found';
    END IF;
    -- the mail must be the one THIS run answers (a claim of this connection that the run is linked to, started from, or answers in): a caller that holds the grant cannot name
    -- another thread's mail and so cannot choose whom the reply goes to
    IF NOT EXISTS (SELECT 1 FROM app.connection_mail_claims_of_run(app.run_id(), p_body) k WHERE k.connection_id = p_connection AND k.mail_id = p_reply_to) THEN
      RAISE EXCEPTION 'this run does not answer that mail' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_to := v_orig.from_address;
    v_thread := v_orig.thread_key;
    v_in_reply := v_orig.message_id;
  ELSIF p_tool = 'email.send' THEN
    RAISE EXCEPTION 'a send answers a mail; there is none to answer' USING ERRCODE = 'check_violation';
  ELSE
    IF p_to IS NULL OR btrim(p_to) = '' THEN
      RAISE EXCEPTION 'a draft that answers no mail needs an address' USING ERRCODE = 'check_violation';
    END IF;
    v_to := p_to;
    v_thread := v_ref;
  END IF;

  INSERT INTO app.connection_messages (workspace_id, team_id, connection_id, direction, folder, thread_key, message_id, in_reply_to, from_address, to_address, subject, body)
  VALUES (v_conn.workspace_id, v_conn.team_id, v_conn.id, CASE WHEN p_tool = 'email.send' THEN 'out' ELSE 'draft' END,
          CASE WHEN p_tool = 'email.send' THEN 'Sent' ELSE 'Drafts' END,
          v_thread, v_ref, v_in_reply, v_conn.slug || '@mail.manythreads.invalid', v_to, p_subject, p_body)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- Owned by the system role like every other definer function (the replaced one already is; the new one is made so here).
GRANT CREATE ON SCHEMA app TO manythreads_system;
ALTER FUNCTION app.connection_mail_claims_of_run(uuid, text) OWNER TO manythreads_system;
ALTER FUNCTION app.connection_mail_put_outbound(uuid, text, uuid, text, text, text) OWNER TO manythreads_system;
REVOKE CREATE ON SCHEMA app FROM manythreads_system;
