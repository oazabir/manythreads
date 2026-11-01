-- gateway-mcp 0002: what each bot's tool list looks like and what its Hermes last read (PLAN P14-22). Forward-only: never edit once applied.
--
--  * app.mcp_bot_tools, one row per bot, never a history:
--      pushed_digest / version  the digest of what `tools/list` answers the bot now, and a counter that goes up each time that digest changes. A server
--                               that holds the bot's event streams pushes `list_changed` when the counter is ahead of what it last saw, so a change
--                               made on one replica reaches a stream held by another through the database, not through process memory.
--      listed_digest / listed_at  the digest of the list the bot's token last read, for the bot page's "Hermes has the current tools" line.
--    Digests are hashes of tool names, descriptions and input schemas: no secret, no content of a team.
--  * The system role reads and writes it (the event subscriber, the stream hub, the route that records a listing); manythreads_app never touches it.

CREATE TABLE app.mcp_bot_tools (
  bot_id        uuid PRIMARY KEY REFERENCES app.bots (id) ON DELETE CASCADE,
  pushed_digest text NOT NULL CHECK (pushed_digest ~ '^[0-9a-f]{64}$'),
  version       bigint NOT NULL DEFAULT 1,
  pushed_at     timestamptz NOT NULL DEFAULT now(),
  listed_digest text CHECK (listed_digest ~ '^[0-9a-f]{64}$'),
  listed_at     timestamptz
);
COMMENT ON TABLE app.mcp_bot_tools IS 'rls: system — S: per bot, the digest of its current tool list, a change counter the event streams watch, and the digest its token last listed; written and read as the system role by gateway-mcp, no privilege for manythreads_app.';

ALTER TABLE app.mcp_bot_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mcp_bot_tools FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_bot_tools_system ON app.mcp_bot_tools FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
-- no GRANT to manythreads_app: a table the request role never reads
