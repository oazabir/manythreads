-- example-hello: tag the table with the RLS kind the harness requires (COMMENT ON TABLE ... IS 'rls: <kind>').
COMMENT ON TABLE app.hello_greetings IS 'rls: team — T: greetings of one team, readable by its members.';
