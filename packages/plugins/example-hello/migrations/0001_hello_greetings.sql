-- example-hello: one team-scoped table (T) with RLS. This one file is all a plugin needs to add a table.
CREATE TABLE app.hello_greetings (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  team_id    uuid NOT NULL,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hello_greetings_team ON app.hello_greetings (team_id);

ALTER TABLE app.hello_greetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.hello_greetings FORCE ROW LEVEL SECURITY;
CREATE POLICY hello_greetings_team ON app.hello_greetings
  USING (app.is_team_member(team_id) OR app.is_system())
  WITH CHECK (app.is_team_member(team_id) OR app.is_system());

GRANT SELECT, INSERT ON app.hello_greetings TO majlis_app;
