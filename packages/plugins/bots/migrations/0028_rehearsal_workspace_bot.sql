-- bots 0028 (P20-RUN): the Test action may rehearse the workspace Brain. Forward-only.
--
-- The insert policy of app.rehearsal_questions asked the bot to belong to the question's team (`b.team_id = team_id`). The workspace Brain belongs to no team (0027), so
-- a lead's question to it was refused as a permission error. The team stays the team of the page the lead pressed Test on, and it must be one they manage; a
-- workspace bot is tested from any such team (as a model pick is, 0027 section 3).

DROP POLICY rehearsal_questions_insert ON app.rehearsal_questions;
CREATE POLICY rehearsal_questions_insert ON app.rehearsal_questions FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (
    workspace_id = (SELECT app.workspace_id())
    AND asked_by = (SELECT app.actor())
    AND team_id = ANY ((SELECT app.readable_team_ids('manage'))::uuid[])
    AND EXISTS (SELECT 1 FROM app.bots b WHERE b.id = bot_id AND (b.team_id = rehearsal_questions.team_id OR (b.scope = 'workspace' AND b.team_id IS NULL)))
    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = message_id AND m.author_id = rehearsal_questions.asked_by)
  )
);
