-- channels 0011: a person's own view of the sidebar's channel groups (PLAN P14-15). Forward-only: never edit once applied.
--
--  * channel_stars: the channels a person starred. One row per (person, channel); a person stars only a channel they can read, and the row goes
--    with the channel or the person. The sidebar lists them in a "Starred" group at the top of the channel groups.
--  * sidebar_prefs: one row per (person, team) for the rest of the view: how the groups are sorted (`team` = the order the team set, the default; `recent` = newest message first; or `name`),
--    whether channels with no message for 30 days are folded away, and the order the person put the team's groups in. `group_order` lists group
--    ids (or the team's own id for channels that sit in no group); the route checks them, a group deleted later simply drops out when it is read.
-- Both tables are private to the person: nobody else reads or writes a row (the system role reads them for maintenance). Nothing here is an event:
-- like a notification level, it is the person's own setting and no one else is told.

CREATE TABLE app.channel_stars (
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, channel_id)
);
CREATE INDEX channel_stars_channel ON app.channel_stars (channel_id);
CREATE INDEX channel_stars_workspace ON app.channel_stars (workspace_id);
COMMENT ON TABLE app.channel_stars IS 'rls: person — P: the channels a person starred; a person reads and changes only their own rows, and stars only a channel they can read.';

CREATE TABLE app.sidebar_prefs (
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES app.teams (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  sort         text NOT NULL DEFAULT 'team' CHECK (sort IN ('team', 'recent', 'name')),
  hide_idle    boolean NOT NULL DEFAULT false,
  group_order  uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(group_order) <= 200),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, team_id)
);
CREATE INDEX sidebar_prefs_team ON app.sidebar_prefs (team_id);
CREATE INDEX sidebar_prefs_workspace ON app.sidebar_prefs (workspace_id);
COMMENT ON TABLE app.sidebar_prefs IS 'rls: person — P: how a person sorts, folds and orders the channel groups of one team; a person reads and changes only their own row, for a team they can read.';

ALTER TABLE app.channel_stars ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.channel_stars FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_stars_select ON app.channel_stars FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY channel_stars_insert ON app.channel_stars FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
      AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])));
CREATE POLICY channel_stars_delete ON app.channel_stars FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

ALTER TABLE app.sidebar_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sidebar_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY sidebar_prefs_select ON app.sidebar_prefs FOR SELECT
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));
CREATE POLICY sidebar_prefs_insert ON app.sidebar_prefs FOR INSERT WITH CHECK (
  (SELECT app.is_system())
  OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
      AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));
CREATE POLICY sidebar_prefs_update ON app.sidebar_prefs FOR UPDATE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()))
  WITH CHECK ((SELECT app.is_system())
    OR (person_id = (SELECT app.person_id()) AND workspace_id = (SELECT app.workspace_id())
        AND team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])));
CREATE POLICY sidebar_prefs_delete ON app.sidebar_prefs FOR DELETE
  USING ((SELECT app.is_system()) OR person_id = (SELECT app.person_id()));

GRANT SELECT, INSERT, DELETE ON app.channel_stars TO manythreads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.sidebar_prefs TO manythreads_app;
